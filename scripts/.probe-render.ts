import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { newBudget, htmlToText } from "../src/lib/research/fetcher";
import { renderPage } from "../src/lib/research/sources/rendered";

async function main() {
  const b = newBudget(60_000);
  const html = await renderPage("https://kairollm.live/docs", b);
  if (!html) { console.log("render failed"); return; }
  console.log("rendered HTML chars:", html.length);
  const { title, headings, text } = htmlToText(html);
  console.log("title:", title, "| headings:", headings.length, "| text chars:", text.length);
  console.log("--- text ---");
  console.log(text.slice(0, 2600));
  console.log("--- raw markup around a percentage ---");
  for (const m of html.matchAll(/[^<>]{0,40}\d{1,3}\s*%[^<>]{0,40}/g)) console.log("   ", JSON.stringify(m[0]));
}
main();
