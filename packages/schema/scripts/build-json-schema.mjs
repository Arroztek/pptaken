// Writes dist/deck.schema.json from the compiled schema. Run after `tsc`.
import { mkdirSync, writeFileSync } from "node:fs";
import { DECK_SCHEMA_VERSION, deckJsonSchema } from "../dist/index.js";

const schema = {
  $id: `https://pptaken.dev/schema/deck/v${DECK_SCHEMA_VERSION}.json`,
  title: "PPTaken deck",
  ...deckJsonSchema(),
};
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../dist/deck.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
console.log("schema: wrote dist/deck.schema.json");
