// Validation officielle des XML CII générés par auto-facturx : XSD CII D16B et Schematron EN 16931
// (ConnectingEurope/eInvoicing-EN16931, versions épinglées ci-dessous, mises en cache dans .cache/).
import { $ } from "bun";

const RELEASE = "validation-1.3.17";
const ZIP = `en16931-cii-${RELEASE.slice(11)}.zip`;
const COMMIT = "6e35e0ab8b09eb183f7d84b282e24ef95f9f5715";
const SCHEMA = "cii/schema/D16B SCRDM (Subset)/uncoupled clm/CII/uncefact";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const cache = `${root}.cache/en16931/${RELEASE}`;
const xslt = `${cache}/xslt/EN16931-CII-validation.xslt`;
const xsd = `${cache}/schema/data/standard/CrossIndustryInvoice_100pD16B.xsd`;

if (!(await Bun.file(xslt).exists())) {
  await $`mkdir -p ${cache}`;
  await $`gh release download ${RELEASE} -R ConnectingEurope/eInvoicing-EN16931 -p ${ZIP} -D ${cache} --clobber`;
  await $`unzip -q -o ${`${cache}/${ZIP}`} ${"xslt/*"} -d ${cache}`;
}
if (!(await Bun.file(xsd).exists())) {
  const tree = (await $`gh api repos/ConnectingEurope/eInvoicing-EN16931/git/trees/${COMMIT}?recursive=1`.json()) as {
    tree: { path: string; type: string }[];
  };
  const fichiers = tree.tree.filter((t) => t.type === "blob" && t.path.startsWith(`${SCHEMA}/`));
  await Promise.all(
    fichiers.map(async (t) => {
      const url = `https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/${COMMIT}/${encodeURI(t.path)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} : ${res.status}`);
      await Bun.write(`${cache}/schema/${t.path.slice(SCHEMA.length + 1)}`, res);
    }),
  );
}

const out = `${root}.cache/cii-out`;
await $`sh ${`${root}scripts/cargo.sh`} run -q -p auto-facturx --example echantillons -- /w/.cache/cii-out`;
const xmls = Array.from(new Bun.Glob("*.xml").scanSync(out), (f) => `${out}/${f}`).sort();
const r =
  await $`bun uv run -q --with lxml --with saxonche ${`${root}tools/validate_cii.py`} ${xsd} ${xslt} ${xmls}`.nothrow();
process.exit(r.exitCode);
