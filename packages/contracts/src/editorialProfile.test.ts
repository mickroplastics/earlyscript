import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  EditorialProfileDraft,
  normalizeEditorialProfileDraft,
  scriptLanguageInstruction,
} from "./editorialProfile.ts";

const decodeDraft = Schema.decodeSync(EditorialProfileDraft);

describe("channel language", () => {
  it("decodes legacy profiles as English", () => {
    const legacy = { name: "Channel", audience: "Developers", include: ["AI"], exclude: [] };
    expect(decodeDraft(legacy).language).toBe("en");
  });
  it("names the language for a video thread in Spanish", () => {
    expect(scriptLanguageInstruction("es")).toBe("Idioma del guion: español (es)");
    expect(scriptLanguageInstruction("pt-br")).toBe(
      "Idioma del guion: portugués de Brasil (pt-br)",
    );
    expect(
      normalizeEditorialProfileDraft({
        name: "a",
        audience: "b",
        include: ["c"],
        exclude: [],
        language: " PT-BR ",
      }).language,
    ).toBe("pt-br");
  });
});
