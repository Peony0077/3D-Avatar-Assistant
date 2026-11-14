import { describe, expect, it } from "vitest";
import { SentenceStream, normalizeForSpeech, numberWords, ordinalWords, parseMarkup, splitSentences } from "../src/speech/text";

describe("splitSentences", () => {
  it("splits on sentence punctuation but not abbreviations or decimals", () => {
    expect(splitSentences("Hello there! Dr. Smith paid 3.5 dollars. Is that OK? Yes.")).toEqual([
      "Hello there!", "Dr. Smith paid 3.5 dollars.", "Is that OK?", "Yes.",
    ]);
  });
  it("keeps text without final punctuation", () => {
    expect(splitSentences("One. Two")).toEqual(["One.", "Two"]);
  });
  it("splits very long sentences at a clause boundary", () => {
    const long = "This is a clause, ".repeat(30) + "end.";
    const parts = splitSentences(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(120);
  });
});

describe("SentenceStream", () => {
  it("emits complete sentences as tokens arrive", () => {
    const s = new SentenceStream();
    expect(s.push("Hello the")).toEqual([]);
    expect(s.push("re. How are")).toEqual(["Hello there."]);
    expect(s.push(" you? Fine")).toEqual(["How are you?"]);
    expect(s.flush()).toEqual(["Fine"]);
  });
});

describe("parseMarkup", () => {
  it("assigns moods from tags and emojis, and strips them from speech", () => {
    expect(parseMarkup("[happy] Great news! [neutral] Details follow.")).toEqual([
      { text: "Great news!", mood: "happy" },
      { text: "Details follow.", mood: "neutral" },
    ]);
    expect(parseMarkup("Thanks for asking 😊")).toEqual([{ text: "Thanks for asking", mood: "smile" }]);
  });
  it("removes markdown and urls", () => {
    expect(parseMarkup("**Bold** see https://example.com now")[0].text).toBe("Bold see the link now");
  });
});

describe("normalizeForSpeech", () => {
  const spoken = (s: string) =>
    normalizeForSpeech(s).map((i) => (typeof i === "string" ? i : i.value)).join("").replace(/\s+/g, " ").trim();
  it("reads money, percent, dates, ordinals, titles and ranges", () => {
    expect(spoken("It costs $12.50 today.")).toBe("It costs twelve dollars and fifty cents today.");
    expect(spoken("About 50% humidity.")).toBe("About 50 percent humidity.");
    expect(spoken("On 2026-11-14.")).toBe("On November fourteenth, 2026.");
    expect(spoken("Dr. Smith is 1st.")).toBe("Doctor Smith is first.");
    expect(spoken("Open 9-5 daily.")).toBe("Open 9 to 5 daily.");
  });
  it("keeps the original token as subtitles", () => {
    const items = normalizeForSpeech("Pay $5 now");
    const sp = items.find((i) => typeof i !== "string");
    expect(sp).toEqual({ type: "speech", value: "five dollars ", subtitles: "$5 " });
  });
  it("leaves ordinary text as one plain string", () => {
    expect(normalizeForSpeech("Hello world.")).toEqual(["Hello world."]);
  });
});

describe("number words", () => {
  it("handles common numbers and ordinals", () => {
    expect(numberWords(42)).toBe("forty-two");
    expect(numberWords(1250)).toBe("one thousand two hundred fifty");
    expect(ordinalWords(21)).toBe("twenty-first");
    expect(ordinalWords(30)).toBe("thirtieth");
    expect(ordinalWords(12)).toBe("twelfth");
  });
});
