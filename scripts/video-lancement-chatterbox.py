"""Synthèse locale Chatterbox Multilingual V3 à partir d'une voix consentie."""

import argparse
import json
from pathlib import Path

import torch
import torchaudio as ta
from chatterbox.mtl_tts import ChatterboxMultilingualTTS


parser = argparse.ArgumentParser()
parser.add_argument("--textes", type=Path, required=True)
parser.add_argument("--reference", type=Path, required=True)
parser.add_argument("--destination", type=Path, required=True)
parser.add_argument("--limit", type=int, default=0, help="Nombre de premières scènes à synthétiser pour qualifier la voix")
parser.add_argument("--scene", help="Synthétiser uniquement cette scène")
args = parser.parse_args()

if not torch.cuda.is_available():
    raise RuntimeError("CUDA indisponible ; la synthèse vidéo doit être vérifiée sur le GPU prévu")

args.destination.mkdir(parents=True, exist_ok=True)
# La version PyPI 0.1.7 fournie par `chatterbox-tts` expose le checkpoint V2
# et ne possède pas encore le paramètre `t3_model` documenté sur la branche main.
model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")
model.prepare_conditionals(str(args.reference.resolve()), exaggeration=0.5)
scenes = json.loads(args.textes.read_text(encoding="utf-8-sig"))
if args.scene:
    selected = [scene for scene in scenes if scene["id"] == args.scene]
    if not selected:
        raise ValueError(f"Scène inconnue : {args.scene}")
else:
    selected = scenes[: args.limit] if args.limit > 0 else scenes
for index, scene in enumerate(selected, 1):
    speech = model.generate(
        scene["texte"],
        language_id="fr",
        cfg_weight=0.5,
        exaggeration=0.5,
    )
    target = args.destination / f'{scene["id"]}-voix.wav'
    ta.save(str(target), speech.detach().cpu(), model.sr)
    print(json.dumps({"scene": scene["id"], "progression": f"{index}/{len(selected)}", "fichier": str(target)}, ensure_ascii=False), flush=True)

metadata = {
    "voix": "Voix de l’utilisateur, synthèse locale Chatterbox Multilingual V2",
    "langue": "fr-FR",
    "fournisseur": "ResembleAI/chatterbox",
    "appareil": torch.cuda.get_device_name(0),
    "frequenceSource": model.sr,
    "referenceAudio": "enregistrement de l’utilisateur, utilisé localement avec son accord",
    "horodatageParMots": "non fourni par le modèle ; sous-titres temporisés dans le générateur vidéo",
    "scenes": [{"id": scene["id"], "mots": []} for scene in selected],
}
if not args.scene:
    (args.destination / "paroles-fr.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"ready": True, "gpu": metadata["appareil"], "scenes": len(selected)}, ensure_ascii=False), flush=True)
