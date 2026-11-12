import { genererCss } from "./tokens";

await Bun.write(new URL("./tokens.css", import.meta.url), genererCss());
