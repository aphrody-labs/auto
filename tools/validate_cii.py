"""Validation officielle d'un XML CII : XSD D16B (lxml) puis Schematron EN 16931 (XSLT 2, saxonche).

Usage : validate_cii.py <xsd> <xslt> <fichier.xml>...
Sortie : une ligne par erreur ; code 1 si une erreur XSD ou une assertion fatale échoue.
"""

import sys
from pathlib import Path

from lxml import etree
from saxonche import PySaxonProcessor

SVRL = "{http://purl.oclc.org/dsdl/svrl}"


def main() -> int:
    xsd_path, xslt_path, *files = sys.argv[1:]
    schema = etree.XMLSchema(etree.parse(xsd_path))
    ko = 0
    with PySaxonProcessor(license=False) as proc:
        xslt = proc.new_xslt30_processor().compile_stylesheet(stylesheet_file=xslt_path)
        for f in files:
            doc = etree.parse(f)
            erreurs = [f"XSD ligne {e.line} : {e.message}" for e in schema.error_log] if not schema.validate(doc) else []
            svrl = etree.fromstring(xslt.transform_to_string(source_file=str(Path(f).resolve())).encode())
            for a in svrl.iter(f"{SVRL}failed-assert"):
                flag = a.get("flag", "fatal")
                texte = " ".join("".join(a.find(f"{SVRL}text").itertext()).split())
                if flag == "fatal":
                    erreurs.append(f"{a.get('id')} : {texte}")
                else:
                    print(f"{f} : avertissement {a.get('id')} : {texte}")
            if erreurs:
                ko += 1
                for e in erreurs:
                    print(f"{f} : {e}")
            else:
                print(f"{f} : conforme EN 16931")
    return 1 if ko else 0


if __name__ == "__main__":
    sys.exit(main())
