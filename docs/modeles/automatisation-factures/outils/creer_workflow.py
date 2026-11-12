"""Génère workflow/Workflow_n8n_Factures_Fournisseurs.json (aucune dépendance).

Usage : python creer_workflow.py
"""
import json, uuid
from pathlib import Path

OUT = str(Path(__file__).resolve().parent.parent / "workflow" / "Workflow_n8n_Factures_Fournisseurs.json")


def nid():
    return str(uuid.uuid4())


# ---------------------------------------------------------------- code JS embarqué
JS_PREPARER = r"""
// Prépare la requête pour l'API Claude : le PDF ou l'image est envoyé en base64.
const p = $('Paramètres').first().json;
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const bin = items[i].binary && items[i].binary.data;
  if (!bin) throw new Error('Aucun fichier lu : vérifiez le nœud "Lire le fichier".');
  const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
  const data = buf.toString('base64');
  const mime = bin.mimeType || 'application/pdf';
  const bloc = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data } };

  const outil = {
    name: 'enregistrer_facture',
    description: 'Enregistre les données lues sur une facture fournisseur.',
    input_schema: {
      type: 'object',
      properties: {
        type_document: { type: 'string', enum: ['facture', 'avoir', 'autre'], description: "Nature du document. 'autre' si ce n'est ni une facture ni un avoir." },
        fournisseur_nom: { type: 'string', description: "Raison sociale de l'émetteur de la facture." },
        fournisseur_siret: { type: 'string', description: 'SIRET de l\'émetteur : 14 chiffres sans espaces. Omettre si absent.' },
        numero_facture: { type: 'string', description: 'Numéro de la facture tel qu\'écrit sur le document.' },
        date_facture: { type: 'string', description: 'Date de la facture au format AAAA-MM-JJ.' },
        date_echeance: { type: 'string', description: 'Date d\'échéance au format AAAA-MM-JJ. Omettre si absente.' },
        montant_ht: { type: 'number', description: 'Total hors taxe en euros (négatif pour un avoir).' },
        montant_tva: { type: 'number', description: 'Total de la TVA en euros (négatif pour un avoir).' },
        montant_ttc: { type: 'number', description: 'Total toutes taxes comprises en euros (négatif pour un avoir).' },
        reference_chantier: { type: 'string', description: 'Référence de chantier, d\'affaire ou de commande, ou nom du chantier / adresse de livraison, si présents. Omettre sinon.' },
        compte_charge_suggere: { type: 'string', enum: ['601000', '606000', '611000', '613000', '615000', '616000', '622000', '625000', '626000', '628000'],
          description: '601000 matériaux ; 606000 énergie, fournitures, petit outillage ; 611000 sous-traitance ; 613000 locations ; 615000 entretien, réparations ; 616000 assurances ; 622000 honoraires ; 625000 déplacements ; 626000 télécoms, postaux ; 628000 divers.' },
        confiance: { type: 'string', enum: ['haute', 'moyenne', 'basse'], description: 'Basse si le scan est flou ou si un montant est incertain.' },
        remarques: { type: 'string', description: 'Anomalie constatée (rature, total illisible, plusieurs taux de TVA...). Omettre sinon.' }
      },
      required: ['type_document', 'fournisseur_nom', 'numero_facture', 'date_facture', 'montant_ht', 'montant_tva', 'montant_ttc', 'confiance']
    }
  };

  const requestBody = {
    model: p.modele,
    max_tokens: 1500,
    system: "Tu es assistant comptable dans une entreprise du bâtiment. Tu lis une facture fournisseur (PDF ou scan) et tu appelles l'outil enregistrer_facture. N'invente rien : si une information est absente ou illisible, omets le champ. Les montants sont des nombres décimaux avec un point, sans symbole. Les dates sont au format AAAA-MM-JJ.",
    tools: [outil],
    tool_choice: { type: 'tool', name: 'enregistrer_facture' },
    messages: [{ role: 'user', content: [bloc, { type: 'text', text: 'Extrais les données de ce document.' }] }]
  };
  out.push({ json: { requestBody }, pairedItem: { item: i } });
}
return out;
"""

JS_VALIDER = r"""
// Lit la réponse de Claude, contrôle les données et prépare la ligne du Journal Excel.
const p = $('Paramètres').first().json;
const r = $input.first().json;
const racine = String(p.racine).replace(/[\\/]+$/, '');
const windows = String(p.systeme).toLowerCase() === 'windows';
const nomFichier = p.nomFichier;

const serial = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : '';
};
const now = new Date();
const nowSerial = (now.getTime() - now.getTimezoneOffset() * 60000) / 86400000 + 25569;
const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
const dirSafe = (s) => s.replace(/[<>:"/\\|?*]+/g, '-');

const bloc = (Array.isArray(r.content) ? r.content : []).find((b) => b.type === 'tool_use');
const d = bloc && bloc.input ? bloc.input : null;
const problemes = [];
let lectureOk = !!d;
if (!d) {
  const err = r.error && (r.error.message || JSON.stringify(r.error));
  problemes.push('Lecture impossible : ' + (err || 'réponse vide de Claude'));
}
const x = d || {};

const ht = num(x.montant_ht), tva = num(x.montant_tva), ttc = num(x.montant_ttc);
const siret = String(x.fournisseur_siret || '').replace(/\D/g, '');
let chantier = x.reference_chantier
  ? String(x.reference_chantier).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  : '';

if (d) {
  if (!x.numero_facture) problemes.push('N° de facture non lu');
  if (!serial(x.date_facture)) problemes.push('Date de facture non lue');
  if (!x.fournisseur_nom) problemes.push('Fournisseur non lu');
  if (ttc === null) problemes.push('Montant TTC non lu');
  else if (ht !== null && tva !== null && Math.abs(ht + tva - ttc) > 0.02) problemes.push('HT + TVA différent du TTC');
  if (x.type_document && x.type_document !== 'facture') problemes.push('Document de type : ' + x.type_document);
  if (x.confiance === 'basse') problemes.push('Confiance de lecture basse');
  if (siret && siret.length !== 14) problemes.push('SIRET invalide');
}

const controle = problemes.length ? 'À VÉRIFIER' : 'OK';
const annee = (String(x.date_facture || '').slice(0, 4).match(/^\d{4}$/) || [String(now.getFullYear())])[0];
const dest = lectureOk && controle === 'OK'
  ? racine + '/Traitees/' + dirSafe(chantier || 'A_AFFECTER') + '/' + annee
  : racine + '/Erreurs';

const commentaire = [
  problemes.join(' ; '),
  x.remarques || '',
  chantier ? 'Réf. chantier lue : ' + x.reference_chantier : '',
  x.compte_charge_suggere ? 'Compte suggéré par l\'IA' : ''
].filter(Boolean).join(' | ');

const row = {
  'Date facture': serial(x.date_facture),
  'Fournisseur (nom lu)': x.fournisseur_nom || '',
  'SIRET': siret,
  'N° facture': x.numero_facture ? String(x.numero_facture) : 'SANS-NUMERO-' + stamp,
  'Code chantier': chantier,
  'Compte charge': x.compte_charge_suggere || '',
  'Montant HT': ht === null ? '' : ht,
  'Montant TVA': tva === null ? '' : tva,
  'Montant TTC': ttc === null ? '' : ttc,
  'Échéance (si lue)': serial(x.date_echeance),
  'Litige (O)': '',
  'Lien PDF': dest + '/' + nomFichier,
  'Source': 'n8n',
  'Contrôle OCR': controle,
  'Commentaire': commentaire,
  'Date import': nowSerial
};

// Commande qui range le fichier scanné (dossier créé au besoin, aucun écrasement).
const sh = (s) => windows ? "'" + s.replace(/'/g, "''") + "'" : "'" + s.replace(/'/g, "'\\''") + "'";
const toWin = (s) => s.replace(/\//g, '\\');
const src = windows ? toWin(p.path) : p.path;
const dir = windows ? toWin(dest) : dest;
let commande;
if (windows) {
  const ps = '$s=' + sh(src) + '; $dir=' + sh(dir) + '; New-Item -ItemType Directory -Force -Path $dir | Out-Null; '
    + '$n=[IO.Path]::GetFileName($s); $d=Join-Path $dir $n; '
    + "if (Test-Path -LiteralPath $d) { $n=[IO.Path]::GetFileNameWithoutExtension($n)+'_'+(Get-Date -Format yyyyMMddHHmmss)+[IO.Path]::GetExtension($n); $d=Join-Path $dir $n }; "
    + 'Move-Item -LiteralPath $s -Destination $d -Force';
  commande = 'powershell -NoProfile -NonInteractive -Command "' + ps + '"';
} else {
  commande = 'mkdir -p ' + sh(dir) + ' && mv --backup=numbered -- ' + sh(src) + ' ' + sh(dir + '/');
}

return [{ json: { ...row, lectureOk, controle, problemes, nomFichier, destDossier: dest, commandeRanger: commande } }];
"""

JS_RELANCE = r"""
// Construit le récapitulatif quotidien : retards, échéances proches, points à vérifier.
const lignes = $input.all().map((i) => i.json).filter((r) => String(r['N° facture'] || '') !== '');
const today = new Date();
const todaySerial = Math.floor((today.getTime() - today.getTimezoneOffset() * 60000) / 86400000) + 25569;
const eur = (v) => Number(v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const date = (s) => (typeof s === 'number' ? new Date(Math.round((s - 25569) * 86400000)).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '?');
const fmt = (r) => `- ${r['Fournisseur']} | facture ${r['N° facture']} | échéance ${date(r['Échéance'])} | reste dû ${eur(r['Reste dû'])}`;

const retard = lignes.filter((r) => r['Statut'] === 'En retard');
const proches = lignes.filter((r) => ['À payer', 'Partiellement payée'].includes(r['Statut'])
  && typeof r['Échéance'] === 'number' && r['Échéance'] - todaySerial >= 0 && r['Échéance'] - todaySerial <= 7);
const litiges = lignes.filter((r) => r['Statut'] === 'Litige');
const verifier = lignes.filter((r) => r['Contrôle OCR'] === 'À VÉRIFIER' || r['Contrôle montants'] === 'ÉCART'
  || r['Code fournisseur'] === 'À CRÉER' || r['Doublon'] === 'DOUBLON (ignoré)');

if (!retard.length && !proches.length && !litiges.length && !verifier.length) return [];

const bloc = (titre, liste, f) => (liste.length ? `${titre} (${liste.length})\n${liste.map(f).join('\n')}\n\n` : '');
const total = (liste) => liste.reduce((s, r) => s + Number(r['Reste dû'] || 0), 0);
const texte = `Récapitulatif du ${today.toLocaleDateString('fr-FR')}\n\n`
  + bloc(`FACTURES EN RETARD - ${eur(total(retard))}`, retard, (r) => fmt(r) + ` | ${r['Jours de retard']} j de retard`)
  + bloc(`À PAYER SOUS 7 JOURS - ${eur(total(proches))}`, proches, fmt)
  + bloc('EN LITIGE', litiges, fmt)
  + bloc('À VÉRIFIER DANS LE JOURNAL', verifier, (r) => `- ${r['Fournisseur']} | facture ${r['N° facture']} | ${[r['Contrôle OCR'] === 'À VÉRIFIER' ? 'lecture à vérifier' : '', r['Contrôle montants'] === 'ÉCART' ? 'écart de montants' : '', r['Code fournisseur'] === 'À CRÉER' ? 'fournisseur à créer' : '', r['Doublon'] === 'DOUBLON (ignoré)' ? 'doublon' : ''].filter(Boolean).join(', ')}`);

return [{ json: { sujet: `Factures fournisseurs : ${retard.length} en retard, ${proches.length} à payer sous 7 jours`, texte, nbRetard: retard.length, nbProches: proches.length } }];
"""

# ---------------------------------------------------------------- noeuds
def rlc(name):
    return {"__rl": True, "mode": "list", "value": "", "cachedResultName": name}


EXCEL_CRED = {"microsoftExcelOAuth2Api": {"id": "REMPLACER", "name": "Microsoft Excel OAuth2"}}
SMTP_CRED = {"smtp": {"id": "REMPLACER", "name": "SMTP"}}
WB = rlc("Classeur_Factures_Fournisseurs.xlsx")

nodes = []


def add(name, type_, version, pos, params, **extra):
    n = {"parameters": params, "id": nid(), "name": name, "type": type_, "typeVersion": version, "position": pos}
    n.update(extra)
    nodes.append(n)
    return name


def assign(name, value, typ="string"):
    return {"id": nid(), "name": name, "value": value, "type": typ}


# ---- Bloc A : traitement des scans
add("Nouveau scan (dossier réseau)", "n8n-nodes-base.localFileTrigger", 1, [0, 0], {
    "triggerOn": "folder",
    "path": "//SERVEUR/Scans/A_traiter",
    "events": ["add"],
    "options": {"awaitWriteFinish": True, "usePolling": True, "ignoreInitial": True, "depth": 0, "ignored": "**/Thumbs.db"},
})
add("Paramètres", "n8n-nodes-base.set", 3.4, [260, 0], {
    "assignments": {"assignments": [
        assign("racine", "//SERVEUR/Scans"),
        assign("systeme", "windows"),
        assign("modele", "claude-sonnet-5-5"),
        assign("emailAlerte", "compta@votre-entreprise.fr"),
        assign("cheminFichier", "={{ $json.path.replace(/\\\\/g, '/') }}"),
        assign("nomFichier", "={{ $json.path.split(/[\\\\/]/).pop() }}"),
    ]},
    "includeOtherFields": True,
    "options": {},
})
add("PDF ou image ?", "n8n-nodes-base.if", 2.2, [520, 0], {
    "conditions": {
        "options": {"caseSensitive": False, "leftValue": "", "typeValidation": "loose", "version": 2},
        "conditions": [{"id": nid(), "leftValue": "={{ $json.nomFichier.toLowerCase() }}", "rightValue": "\\.(pdf|png|jpe?g)$",
                        "operator": {"type": "string", "operation": "regex"}}],
        "combinator": "and",
    },
    "options": {},
})
add("Lire le fichier", "n8n-nodes-base.readWriteFile", 1.1, [780, -100], {
    "operation": "read",
    "fileSelector": "={{ $json.cheminFichier }}",
    "options": {},
})
add("Préparer la requête Claude", "n8n-nodes-base.code", 2, [1040, -100], {"jsCode": JS_PREPARER.strip()})
add("Claude : extraire la facture", "n8n-nodes-base.httpRequest", 4.2, [1300, -100], {
    "method": "POST",
    "url": "https://api.anthropic.com/v1/messages",
    "authentication": "genericCredentialType",
    "genericAuthType": "httpHeaderAuth",
    "sendHeaders": True,
    "headerParameters": {"parameters": [{"name": "anthropic-version", "value": "2023-06-01"},
                                         {"name": "content-type", "value": "application/json"}]},
    "sendBody": True,
    "specifyBody": "json",
    "jsonBody": "={{ JSON.stringify($json.requestBody) }}",
    "options": {"timeout": 120000},
}, credentials={"httpHeaderAuth": {"id": "REMPLACER", "name": "Anthropic API (x-api-key)"}},
    retryOnFail=True, maxTries=3, waitBetweenTries=5000, onError="continueRegularOutput")
add("Valider et normaliser", "n8n-nodes-base.code", 2, [1560, -100], {"jsCode": JS_VALIDER.strip()})
add("Lecture réussie ?", "n8n-nodes-base.if", 2.2, [1820, -100], {
    "conditions": {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
        "conditions": [{"id": nid(), "leftValue": "={{ $json.lectureOk }}", "rightValue": "",
                        "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
        "combinator": "and",
    },
    "options": {},
})
add("Ajouter au Journal Excel", "n8n-nodes-base.microsoftExcel", 2.2, [2080, -200], {
    "resource": "table",
    "operation": "append",
    "workbook": WB,
    "worksheet": rlc("Journal"),
    "table": rlc("tblJournal"),
    "dataMode": "autoMap",
    "options": {},
}, credentials=EXCEL_CRED)
add("Ranger le fichier", "n8n-nodes-base.executeCommand", 1, [2340, -100], {
    "command": "={{ $('Valider et normaliser').first().json.commandeRanger }}",
})
add("À signaler ?", "n8n-nodes-base.if", 2.2, [2600, -100], {
    "conditions": {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
        "conditions": [{"id": nid(), "leftValue": "={{ $('Valider et normaliser').first().json.controle }}", "rightValue": "OK",
                        "operator": {"type": "string", "operation": "notEquals"}}],
        "combinator": "and",
    },
    "options": {},
})
add("Alerte e-mail (facture à vérifier)", "n8n-nodes-base.emailSend", 2.1, [2860, -100], {
    "fromEmail": "={{ $('Paramètres').first().json.emailAlerte }}",
    "toEmail": "={{ $('Paramètres').first().json.emailAlerte }}",
    "subject": "=Facture à vérifier : {{ $('Valider et normaliser').first().json.nomFichier }}",
    "emailFormat": "text",
    "text": "=Une facture demande un contrôle humain.\n\nFichier : {{ $('Valider et normaliser').first().json.destDossier }}/{{ $('Valider et normaliser').first().json.nomFichier }}\nMotifs : {{ $('Valider et normaliser').first().json.problemes.join(' ; ') }}\n\nCorrigez la ligne dans le Journal Excel (colonne Contrôle OCR), puis passez-la à OK.",
    "options": {},
}, credentials=SMTP_CRED, disabled=True)

# ---- Bloc B : récapitulatif quotidien
add("Chaque matin à 8 h", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 520], {
    "rule": {"interval": [{"field": "days", "daysInterval": 1, "triggerAtHour": 8}]},
})
add("Lire la feuille Suivi", "n8n-nodes-base.microsoftExcel", 2.2, [260, 520], {
    "resource": "worksheet",
    "operation": "readRows",
    "workbook": WB,
    "worksheet": rlc("Suivi"),
    "dataStartRow": 1,
    "options": {},
}, credentials=EXCEL_CRED)
add("Préparer le récapitulatif", "n8n-nodes-base.code", 2, [520, 520], {"jsCode": JS_RELANCE.strip()})
add("Envoyer le récapitulatif", "n8n-nodes-base.emailSend", 2.1, [780, 520], {
    "fromEmail": "compta@votre-entreprise.fr",
    "toEmail": "compta@votre-entreprise.fr",
    "subject": "={{ $json.sujet }}",
    "emailFormat": "text",
    "text": "={{ $json.texte }}",
    "options": {},
}, credentials=SMTP_CRED, disabled=True)

# ---- Notes
add("Note - Prérequis", "n8n-nodes-base.stickyNote", 1, [-20, -560], {
    "width": 760, "height": 400, "color": 4,
    "content": "## Avant d'activer ce workflow\n"
               "1. **Variable d'environnement** : `NODES_EXCLUDE=[]` (n8n 2.x désactive par défaut *Local File Trigger* et *Execute Command*), puis redémarrer n8n.\n"
               "2. **Credentials** : `Anthropic API` (en-tête `x-api-key`), `Microsoft Excel OAuth2`, `SMTP` (facultatif).\n"
               "3. **Classeur** : placer `Classeur_Factures_Fournisseurs.xlsx` dans OneDrive, puis choisir classeur, feuille `Journal` et table `tblJournal` dans le nœud *Ajouter au Journal Excel* (idem `Suivi` dans *Lire la feuille Suivi*).\n"
               "4. **Dossiers** : créer `A_traiter`, `Traitees`, `Erreurs` dans le partage. Le chemin du déclencheur et la valeur `racine` du nœud *Paramètres* doivent désigner le même partage.\n"
               "5. n8n doit pouvoir lire/écrire le partage (compte de service, ou volume monté si Docker, avec `systeme` = `linux`).\n"
               "6. Activer les nœuds e-mail (désactivés par défaut) une fois SMTP configuré.",
})
add("Note - Bloc A", "n8n-nodes-base.stickyNote", 1, [770, -330], {
    "width": 1700, "height": 380, "color": 7,
    "content": "## A. Scan déposé > lecture par Claude > Journal Excel > classement\n"
               "Un scan arrive dans `A_traiter` : Claude lit le PDF ou l'image, le code contrôle les données (HT + TVA = TTC, champs obligatoires), "
               "la ligne est ajoutée au tableau **Journal**, puis le fichier est rangé dans `Traitees/<chantier>/<année>` ou dans `Erreurs` si un doute subsiste. "
               "Une facture douteuse est quand même inscrite au Journal avec *Contrôle OCR* = À VÉRIFIER.",
})
add("Note - Bloc B", "n8n-nodes-base.stickyNote", 1, [-20, 340], {
    "width": 900, "height": 150, "color": 6,
    "content": "## B. Suivi des paiements : récapitulatif quotidien\n"
               "Chaque matin, lecture de la feuille **Suivi** puis e-mail avec les factures en retard, à payer sous 7 jours, en litige ou à vérifier. Aucun e-mail s'il n'y a rien à signaler. "
               "Les paiements se saisissent dans la feuille **Paiements** du classeur.",
})

# ---------------------------------------------------------------- connexions
def link(a, b, out=0):
    connections.setdefault(a, {"main": []})
    main = connections[a]["main"]
    while len(main) <= out:
        main.append([])
    main[out].append({"node": b, "type": "main", "index": 0})


connections = {}
link("Nouveau scan (dossier réseau)", "Paramètres")
link("Paramètres", "PDF ou image ?")
link("PDF ou image ?", "Lire le fichier", 0)
link("Lire le fichier", "Préparer la requête Claude")
link("Préparer la requête Claude", "Claude : extraire la facture")
link("Claude : extraire la facture", "Valider et normaliser")
link("Valider et normaliser", "Lecture réussie ?")
link("Lecture réussie ?", "Ajouter au Journal Excel", 0)
link("Lecture réussie ?", "Ranger le fichier", 1)
link("Ajouter au Journal Excel", "Ranger le fichier")
link("Ranger le fichier", "À signaler ?")
link("À signaler ?", "Alerte e-mail (facture à vérifier)", 0)
link("Chaque matin à 8 h", "Lire la feuille Suivi")
link("Lire la feuille Suivi", "Préparer le récapitulatif")
link("Préparer le récapitulatif", "Envoyer le récapitulatif")

wf = {
    "name": "Factures fournisseurs - scan, Excel et suivi des paiements",
    "nodes": nodes,
    "connections": connections,
    "pinData": {},
    "settings": {"executionOrder": "v1"},
    "meta": {"templateCredsSetupCompleted": False},
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(wf, fh, ensure_ascii=False, indent=2)
print("OK", OUT, len(nodes), "noeuds")
