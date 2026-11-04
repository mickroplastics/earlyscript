"""Compare independent source backtests with a shared-baseline matrix, offline."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
for flag in ("corpus", "profile", "cache", "cutoffs", "out"):
    parser.add_argument(f"--{flag}", required=True)
parser.add_argument("--baseline", default="hn,github")
parser.add_argument("--truth")
parser.add_argument("--candidate", action="append", required=True)
parser.add_argument("--repetitions", type=int, default=3)
args = parser.parse_args()
if len(args.candidate) < 2 or args.repetitions < 1:
    parser.error("use at least two candidates and a positive repetition count")
repo = Path(__file__).resolve().parents[2]
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=False)
metadata = {
    "platform": platform.platform(),
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
    "diff_sha256": hashlib.sha256(subprocess.check_output(["git", "diff", "HEAD"], cwd=repo)).hexdigest(),
    "arguments": vars(args),
}
(out / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
common = ["node", str(repo / "packages/trend-engine/src/cli.ts"), "backtest",
          "--corpus", str(Path(args.corpus).resolve()),
          "--profile", str(Path(args.profile).resolve()),
          "--cache", str(Path(args.cache).resolve()), "--cache-only",
          "--cutoffs", args.cutoffs, "--baseline", args.baseline]
if args.truth:
    common += ["--truth", args.truth]
trials = []
for repetition in range(args.repetitions):
    trial = {"repetition": repetition + 1}
    for mode in (["independent", "matrix"] if repetition % 2 == 0 else ["matrix", "independent"]):
        mode_out = out / str(repetition + 1) / mode
        mode_out.mkdir(parents=True)
        started = time.perf_counter()
        reports = []
        sets = [[candidate] for candidate in args.candidate] if mode == "independent" else [args.candidate]
        for index, candidates in enumerate(sets):
            command = common + ["--out", str(mode_out / str(index))]
            for candidate in candidates:
                command += ["--candidate", candidate]
            (mode_out / f"{index}-command.json").write_text(json.dumps(command) + "\n")
            with (mode_out / f"{index}.stdout").open("w") as stdout, (mode_out / f"{index}.stderr").open("w") as stderr:
                subprocess.run(command, cwd=repo, stdout=stdout, stderr=stderr, check=True)
            reports.extend(json.loads(line) for line in (mode_out / f"{index}.stdout").read_text().splitlines())
        trial[mode] = {"seconds": time.perf_counter() - started, "reports": reports}
        print(json.dumps({"repetition": repetition + 1, "mode": mode, "seconds": trial[mode]["seconds"]}), flush=True)
    independent = [r["logical_hash"] for r in trial["independent"]["reports"]]
    matrix = [r["logical_hash"] for r in trial["matrix"]["reports"]]
    if independent != matrix:
        raise RuntimeError(f"Logical hashes differ in repetition {repetition + 1}")
    trial["identical_logical_hashes"] = True
    trials.append(trial)
    (out / "benchmark.json").write_text(json.dumps(trials, indent=2) + "\n")
