// Curated RSS/Atom feeds for the `rss` source. Editing this list changes the source's
// selection, which is part of the corpus hash. Checked on 31 October 2026: each feed answered
// 200 with RSS or Atom and its site's robots.txt allows the feed path for `*`.
// Licenses were not verified feed by feed: unless `license` says otherwise, assume the
// publisher's copyright. The corpus keeps title, link and the feed's own excerpt (at most
// 4000 characters) for private analysis; nothing is republished.

export interface RssFeed {
  /** Stable slug, part of every item id: `itm_rss_<id>_<hash>`. */
  readonly id: string;
  readonly name: string;
  readonly feedUrl: string;
  readonly siteUrl: string;
  readonly license: string;
  /** Why the feed belongs in the niche (coding agents, local LLMs, developer tools). */
  readonly why: string;
}

const COPYRIGHT = "Not stated in the feed; publisher copyright assumed";

export const RSS_FEEDS: ReadonlyArray<RssFeed> = [
  {
    id: "openai",
    name: "OpenAI News",
    feedUrl: "https://openai.com/news/rss.xml",
    siteUrl: "https://openai.com/news/",
    license: COPYRIGHT,
    why: "Model, Codex and API launches that drive developer interest.",
  },
  {
    id: "deepmind",
    name: "Google DeepMind Blog",
    feedUrl: "https://deepmind.google/blog/rss.xml",
    siteUrl: "https://deepmind.google/blog/",
    license: COPYRIGHT,
    why: "Gemini and research releases.",
  },
  {
    id: "huggingface",
    name: "Hugging Face Blog",
    feedUrl: "https://huggingface.co/blog/feed.xml",
    siteUrl: "https://huggingface.co/blog",
    license: COPYRIGHT,
    why: "Open models, local inference and tooling.",
  },
  {
    id: "github-blog",
    name: "The GitHub Blog",
    feedUrl: "https://github.blog/feed/",
    siteUrl: "https://github.blog/",
    license: COPYRIGHT,
    why: "Copilot and agent features in the largest developer platform.",
  },
  {
    id: "ollama",
    name: "Ollama Blog",
    feedUrl: "https://ollama.com/blog/rss.xml",
    siteUrl: "https://ollama.com/blog",
    license: COPYRIGHT,
    why: "Reference runtime for local LLMs.",
  },
  {
    id: "simonwillison",
    name: "Simon Willison's Weblog",
    feedUrl: "https://simonwillison.net/atom/everything/",
    siteUrl: "https://simonwillison.net/",
    license: COPYRIGHT,
    why: "Daily, fast coverage of LLM tools and coding agents.",
  },
  {
    id: "latent-space",
    name: "Latent Space",
    feedUrl: "https://www.latent.space/feed",
    siteUrl: "https://www.latent.space/",
    license: COPYRIGHT,
    why: "AI engineering newsletter and podcast.",
  },
  {
    id: "pragmatic-engineer",
    name: "The Pragmatic Engineer",
    feedUrl: "https://newsletter.pragmaticengineer.com/feed",
    siteUrl: "https://newsletter.pragmaticengineer.com/",
    license: `${COPYRIGHT}; robots.txt Content-Signal ai-input=yes, ai-train=no`,
    why: "How engineering teams adopt AI tools; paid posts expose only a teaser.",
  },
  {
    id: "interconnects",
    name: "Interconnects",
    feedUrl: "https://www.interconnects.ai/feed",
    siteUrl: "https://www.interconnects.ai/",
    license: COPYRIGHT,
    why: "Open models and post-training analysis.",
  },
  {
    id: "ahead-of-ai",
    name: "Ahead of AI (Sebastian Raschka)",
    feedUrl: "https://magazine.sebastianraschka.com/feed",
    siteUrl: "https://magazine.sebastianraschka.com/",
    license: COPYRIGHT,
    why: "LLM research explained for practitioners.",
  },
  {
    id: "lucumr",
    name: "Armin Ronacher's Thoughts and Writings",
    feedUrl: "https://lucumr.pocoo.org/feed.atom",
    siteUrl: "https://lucumr.pocoo.org/",
    license: COPYRIGHT,
    why: "Practitioner essays on agentic coding.",
  },
  {
    id: "mitchellh",
    name: "Mitchell Hashimoto",
    feedUrl: "https://mitchellh.com/feed.xml",
    siteUrl: "https://mitchellh.com/",
    license: COPYRIGHT,
    why: "Developer-tool author writing on AI-assisted development.",
  },
  {
    id: "hamel",
    name: "Hamel Husain",
    feedUrl: "https://hamel.dev/index.xml",
    siteUrl: "https://hamel.dev/",
    license: COPYRIGHT,
    why: "LLM evals and applied AI engineering.",
  },
  {
    id: "martinfowler",
    name: "Martin Fowler",
    feedUrl: "https://martinfowler.com/feed.atom",
    siteUrl: "https://martinfowler.com/",
    license: COPYRIGHT,
    why: "Software practice, including the series on generative AI in development.",
  },
];
