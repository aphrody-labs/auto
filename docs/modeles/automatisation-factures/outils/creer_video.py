"""Génère video/video_automatisation_factures.mp4 (1080p, voix off française).

Windows uniquement (voix Microsoft Hortense via System.Speech et PowerShell).
Dépendances : pip install pillow imageio-ffmpeg
Usage : python creer_video.py
"""
import json, os, subprocess, tempfile, wave
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

W, H = 1920, 1080
BUILD = os.path.join(tempfile.gettempdir(), "auto_video_build")
FINAL = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "video", "video_automatisation_factures.mp4"))
PS1 = os.path.join(BUILD, "tts.ps1")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
os.makedirs(BUILD, exist_ok=True)

BG = (15, 23, 42)
PANEL = (30, 41, 59)
PANEL2 = (51, 65, 85)
ACC = (56, 189, 248)
GREEN = (74, 222, 128)
ORANGE = (251, 146, 60)
RED = (248, 113, 113)
TXT = (241, 245, 249)
MUTED = (148, 163, 184)
PAPER = (246, 246, 240)
INK = (30, 41, 59)


def F(size, bold=False):
    return ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf", size)


def MONO(size):
    return ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", size)


def rr(d, box, fill=None, outline=None, r=24, w=3):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=w)


def tc(d, cx, cy, s, font, fill=TXT, lh=None):
    lines = s.split("\n")
    lh = lh or int(font.size * 1.25)
    y0 = cy - (len(lines) - 1) * lh / 2
    for i, ln in enumerate(lines):
        d.text((cx, y0 + i * lh), ln, font=font, fill=fill, anchor="mm")


def tl(d, x, y, s, font, fill=TXT):
    d.text((x, y), s, font=font, fill=fill, anchor="lm")


def arrow(d, x1, y, x2, color):
    d.line([(x1, y), (x2 - 14, y)], fill=color, width=6)
    d.polygon([(x2, y), (x2 - 22, y - 14), (x2 - 22, y + 14)], fill=color)


def check(d, cx, cy, color=GREEN, r=26):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    d.line([(cx - 11, cy), (cx - 3, cy + 9), (cx + 12, cy - 9)], fill=BG, width=6)


def wrap(d, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if d.textlength(t, font=font) <= maxw:
            cur = t
        else:
            lines.append(cur)
            cur = w_
    lines.append(cur)
    return lines


# ---------------------------------------------------------------- scenes
def s_title(d, s):
    tc(d, W // 2, 330, "Automatiser les factures fournisseurs", F(92, True))
    tc(d, W // 2, 440, "et l'analytique de chantier avec Excel", F(70), ACC)
    tc(d, W // 2, 540, "Le procédé expliqué simplement, étape par étape", F(40), MUTED)
    if s >= 1:
        for i, (a, b, c) in enumerate([("Moins de saisie", "Plus de ressaisie manuelle", GREEN),
                                       ("Coûts en direct", "Chaque chantier suivi en temps réel", ORANGE)]):
            x = 330 + i * 650
            rr(d, (x, 620, x + 600, 800), fill=PANEL, outline=c)
            tc(d, x + 300, 690, a, F(48, True), c)
            tc(d, x + 300, 760, b, F(32), TXT)


def s_probleme(d, s):
    items = [("Facture\npapier / PDF", MUTED), ("Saisie\nmanuelle", ORANGE), ("Erreurs, doublons,\nretards", RED)]
    for i, (t, c) in enumerate(items):
        x = 130 + i * 590
        on = s >= i + 1
        rr(d, (x, 330, x + 480, 590), fill=PANEL if on else BG, outline=c if on else PANEL2, w=4)
        if on:
            tc(d, x + 240, 460, t, F(50, True), c)
        if i < 2:
            arrow(d, x + 500, 460, x + 570, ACC if s >= i + 2 else PANEL2)
    if s >= 3:
        tc(d, W // 2, 720, "Les coûts de chantier sont connus trop tard", F(46, True), RED)


def s_pipeline(d, s):
    boxes = [("1", "Scanner", "Papier vers PDF"), ("2", "Dossier\nréseau", "\\\\SERVEUR\\Scans"),
             ("3", "Lecture\nOCR", "n8n + reconnaissance"), ("4", "Base Excel", "1 ligne = 1 facture"),
             ("5", "Tableau\nde bord", "Coûts par chantier")]
    lit = {0: 0, 1: 0, 2: 2, 3: 3, 4: 4, 5: 5}[s]
    for i, (n, t, sub) in enumerate(boxes):
        x = 70 + i * 370
        on = i < lit
        cur = i == lit - 1 or (s == 2 and i < 2)
        rr(d, (x, 330, x + 300, 590), fill=(14, 80, 110) if cur else (PANEL if on else BG),
           outline=ACC if on else PANEL2, w=4)
        d.ellipse([x + 20, 346, x + 76, 402], fill=ACC if on else PANEL2)
        tc(d, x + 48, 374, n, F(34, True), BG if on else MUTED)
        tc(d, x + 150, 490, t, F(46, True), TXT if on else MUTED)
        if on:
            tc(d, x + 150, 640, sub, F(30), ACC)
        if i < 4:
            arrow(d, x + 312, 460, x + 362, ACC if i + 1 < lit else PANEL2)


def s_dossier(d, s):
    rr(d, (80, 170, 1130, 860), fill=PANEL)
    f = MONO(40)
    lines = [(0, "\\\\SERVEUR\\Scans\\", 1, ACC), (1, "A_traiter\\", 1, TXT),
             (2, "2026-10-12_Point-P_F20481.pdf", 2, TXT), (2, "2026-10-13_EDF_F77310.pdf", 2, TXT),
             (1, "Traitees\\", 1, TXT), (2, "CHANTIER-DUPONT\\2026\\", 3, GREEN), (2, "CHANTIER-LYON\\2026\\", 3, GREEN),
             (1, "Erreurs\\", 1, RED if s >= 4 else TXT)]
    for i, (ind, t, st, c) in enumerate(lines):
        if s < st:
            continue
        x, y = 120 + ind * 60, 230 + i * 78
        if s == 2 and i == 2:
            parts = [("2026-10-12", ACC), ("_", MUTED), ("Point-P", ORANGE), ("_", MUTED), ("F20481", GREEN), (".pdf", MUTED)]
            for p, pc in parts:
                tl(d, x, y, p, f, pc)
                x += d.textlength(p, font=f)
        else:
            tl(d, x, y, t, f, c)
    msgs = {1: ("Un dossier partagé", "3 sous-dossiers :\nà traiter, traitées, erreurs", ACC),
            2: ("Un nom de fichier simple", "Date  _  Fournisseur  _  N° facture", ORANGE),
            3: ("Rangement automatique", "Par chantier\net par année", GREEN),
            4: ("Contrôle humain", "Si la lecture échoue,\nune personne vérifie", RED)}
    t, sub, c = msgs[s]
    rr(d, (1190, 330, 1840, 700), fill=PANEL, outline=c, w=4)
    tc(d, 1515, 430, t, F(46, True), c)
    tc(d, 1515, 575, sub, F(38), TXT)


def s_ocr(d, s):
    rr(d, (100, 170, 820, 860), fill=PAPER, r=12)
    tl(d, 140, 225, "POINT P MATÉRIAUX", F(40, True), INK)
    tl(d, 140, 285, "FACTURE N° F20481", F(34, True), INK)
    tl(d, 140, 335, "Date : 12/10/2026", F(30), INK)
    tl(d, 140, 380, "Échéance : 11/11/2026", F(30), INK)
    for i in range(4):
        d.rectangle([140, 450 + i * 50, 780 - (i % 2) * 120, 472 + i * 50], fill=(210, 212, 205))
    tl(d, 140, 700, "Total HT", F(32), INK); tl(d, 560, 700, "1 250,00 €", F(32), INK)
    tl(d, 140, 750, "TVA 20 %", F(32), INK); tl(d, 560, 750, "250,00 €", F(32), INK)
    tl(d, 140, 805, "Total TTC", F(34, True), INK); tl(d, 560, 805, "1 500,00 €", F(34, True), INK)
    if s >= 2:
        for box, c in [((130, 190, 560, 255), ORANGE), ((130, 262, 520, 308), GREEN), ((130, 312, 440, 358), ACC),
                       ((130, 358, 500, 404), ACC), ((130, 680, 790, 725), ACC), ((130, 730, 790, 775), ACC),
                       ((130, 782, 790, 830), ACC)]:
            d.rectangle(box, outline=c, width=5)
    rr(d, (900, 170, 1840, 860), fill=PANEL)
    tl(d, 940, 225, "Données extraites", F(42, True), ACC)
    if s == 1:
        tl(d, 940, 330, "en attente de lecture...", F(36), MUTED)
    else:
        rows = [("Fournisseur", "Point P Matériaux"), ("N° facture", "F20481"), ("Date", "12/10/2026"),
                ("Échéance", "11/11/2026"), ("Total HT", "1 250,00 €"), ("TVA", "250,00 €"), ("Total TTC", "1 500,00 €")]
        for i, (a, b) in enumerate(rows):
            y = 300 + i * 66
            d.line([(940, y + 33), (1800, y + 33)], fill=PANEL2, width=2)
            tl(d, 940, y, a, F(34), MUTED)
            tl(d, 1280, y, b, F(36, True), TXT)
    if s >= 3:
        rr(d, (940, 780, 1800, 840), fill=(20, 83, 45), outline=GREEN)
        tc(d, 1370, 810, "Contrôle : 1 250 + 250 = 1 500   OK", F(34, True), GREEN)


def s_excel(d, s):
    cols = [("Fournisseur", 270, 1), ("N° facture", 190, 1), ("Date", 140, 1), ("Échéance", 150, 1),
            ("HT", 190, 1), ("TTC", 190, 1), ("Chantier", 220, 2), ("Compte", 130, 2), ("Statut", 230, 3)]
    rows = [("Point P", "F20481", "12/10", "11/11", "1 250,00", "1 500,00", "DUPONT", "601", "À payer"),
            ("EDF", "F77310", "13/10", "12/11", "380,00", "456,00", "LYON", "606", "Payée"),
            ("Élec Plus", "2026-118", "02/09", "02/10", "4 800,00", "5 760,00", "DUPONT", "611", "En retard"),
            ("Point P", "F20481", "14/10", "11/11", "1 250,00", "1 500,00", "DUPONT", "601", "Doublon !"),
            ("Loc'Engins", "L-5530", "15/10", "14/11", "920,00", "1 104,00", "LYON", "613", "À payer")]
    x0, y0, hh, rh = 100, 180, 64, 80
    rr(d, (x0 - 20, y0 - 20, x0 + 1720, y0 + hh + 5 * rh + 20), fill=PANEL, r=16)
    x = x0
    for name, wd, st in cols:
        if s >= st:
            hl = s == 2 and st == 2
            d.rectangle([x, y0, x + wd - 4, y0 + hh - 4], fill=(14, 80, 110) if hl else PANEL2)
            tc(d, x + wd // 2, y0 + hh // 2 - 2, name, F(32, True), ACC if hl else TXT)
            for r_, row in enumerate(rows):
                ry = y0 + hh + r_ * rh
                val = row[[c[0] for c in cols].index(name)]
                bg, fg = None, TXT
                if s >= 3 and r_ == 2:
                    bg, fg = (127, 29, 29), TXT
                if s >= 3 and r_ == 3:
                    bg, fg = (124, 63, 10), TXT
                if bg:
                    d.rectangle([x, ry, x + wd - 4, ry + rh - 4], fill=bg)
                if s == 2 and st == 2:
                    d.rectangle([x, ry, x + wd - 4, ry + rh - 4], outline=ACC, width=3)
                if name in ("HT", "TTC"):
                    d.text((x + wd - 24, ry + rh // 2), val, font=F(32), fill=fg, anchor="rm")
                else:
                    tl(d, x + 16, ry + rh // 2, val, F(32), fg)
        x += wd
    if s >= 3:
        rr(d, (100, 690, 700, 760), fill=(127, 29, 29)); tc(d, 400, 725, "Échéance dépassée : rouge", F(32), TXT)
        rr(d, (740, 690, 1340, 760), fill=(124, 63, 10)); tc(d, 1040, 725, "Doublon détecté : orange", F(32), TXT)
    if s >= 4:
        rr(d, (500, 790, 1420, 870), fill=(20, 83, 45), outline=GREEN, w=4)
        tc(d, 960, 830, "Onglet Export  >  logiciel comptable", F(40, True), GREEN)


def s_chantier(d, s):
    data = [("DUPONT", 120, 96), ("LYON", 80, 83), ("MARSEILLE", 60, 21)]
    base, scale = 800, 4.6
    rr(d, (80, 170, 1260, 880), fill=PANEL)
    d.line([(140, base), (1220, base)], fill=MUTED, width=3)
    for i, (n, b, r_) in enumerate(data):
        cx = 330 + i * 350
        d.rectangle([cx - 130, base - b * scale, cx - 10, base], fill=(100, 116, 139))
        d.text((cx - 70, base - b * scale - 24), f"{b} k€", font=F(30), fill=TXT, anchor="mm")
        if s >= 2:
            c = RED if r_ > b else GREEN
            d.rectangle([cx + 10, base - r_ * scale, cx + 130, base], fill=c)
            d.text((cx + 70, base - r_ * scale - 24), f"{r_} k€", font=F(30, True), fill=c, anchor="mm")
        tc(d, cx, base + 38, n, F(32, True))
    d.rectangle([840, 190, 870, 215], fill=(100, 116, 139)); tl(d, 885, 202, "Budget", F(28))
    if s >= 2:
        d.rectangle([1020, 190, 1050, 215], fill=GREEN); tl(d, 1065, 202, "Réalisé", F(28))
    if s >= 3:
        rr(d, (1320, 260, 1840, 520), fill=(127, 29, 29), outline=RED, w=4)
        tc(d, 1580, 340, "LYON dépasse\nson budget", F(46, True), TXT)
        tc(d, 1580, 450, "83 k€ pour 80 k€ prévus\nsoit +4 %", F(34), TXT)
        rr(d, (1320, 560, 1840, 760), fill=PANEL, outline=ACC)
        tc(d, 1580, 620, "Reste à dépenser", F(32), MUTED)
        tc(d, 1580, 700, "Calculé pour chaque chantier", F(34, True), ACC)
    else:
        tc(d, 1580, 500, "Total des factures\npar code chantier", F(40, True), ACC)


def s_regles(d, s):
    items = ["Scanner à 300 dpi, bien droit", "Un nom de fichier normalisé", "Validation humaine en cas de doute",
             "Originaux conservés 10 ans", "Données sensibles : OCR local ou conforme RGPD"]
    for i, t in enumerate(items):
        y = 260 + i * 110
        rr(d, (200, y - 45, 1720, y + 45), fill=PANEL if s > i else BG, outline=PANEL2 if s <= i else ACC)
        if s > i:
            check(d, 270, y)
            tl(d, 340, y, t, F(46, True))


def s_plan(d, s):
    nodes = [("Semaine 1", "Organiser dossiers\net noms de fichiers"), ("Semaine 2", "Construire le\nclasseur Excel"),
             ("Semaines 3-4", "Automatisation\net OCR"), ("Semaines 5-6", "Tableaux de bord,\ntests, mise en service")]
    d.line([(250, 480), (1670, 480)], fill=PANEL2, width=8)
    for i, (a, b) in enumerate(nodes):
        x = 250 + i * 473
        on = s >= i + 1
        d.ellipse([x - 28, 452, x + 28, 508], fill=ACC if on else PANEL2)
        if on:
            tc(d, x, 390, a, F(46, True), ACC)
            tc(d, x, 600, b, F(36), TXT)
    if s >= 5:
        rr(d, (260, 760, 1660, 860), fill=PANEL, outline=GREEN, w=4)
        tc(d, 960, 810, "Classeur Excel modèle  +  workflow n8n : prêts à construire", F(40, True), GREEN)


# (title, draw, [(narration, step), ...])
SCENES = [
    (None, s_title, [("Bonjour. Dans cette vidéo, je vous montre simplement comment automatiser le suivi de vos factures fournisseurs, et l'analytique de vos chantiers, avec Excel.", 0),
                     ("Le but : ne plus ressaisir à la main, et savoir en un coup d'œil ce que coûte chaque chantier.", 1)]),
    ("Le problème actuel", s_probleme, [("Aujourd'hui, la facture arrive sur papier ou en PDF.", 1),
                                        ("Quelqu'un la ressaisit à la main dans un tableau.", 2),
                                        ("Résultat : du temps perdu, des erreurs, des doublons, et des coûts de chantier connus trop tard.", 3)]),
    ("Le principe en 5 étapes", s_pipeline, [("Voici le principe, en cinq étapes.", 0),
                                             ("Premièrement, vous scannez la facture. Elle est déposée dans un dossier partagé du réseau local.", 2),
                                             ("Ensuite, un robot, par exemple n8n, détecte le nouveau fichier et lit son contenu grâce à la reconnaissance de texte, l'OCR.", 3),
                                             ("Les données extraites arrivent automatiquement dans un classeur Excel.", 4),
                                             ("Enfin, un tableau de bord montre les coûts, chantier par chantier.", 5)]),
    ("Étape 1 : le dossier réseau", s_dossier, [("Première étape : un dossier partagé sur le réseau, avec trois sous-dossiers.", 1),
                                                ("Les nouveaux scans arrivent dans « à traiter », avec un nom simple : la date, le fournisseur, et le numéro de facture.", 2),
                                                ("Une fois lues, les factures sont rangées par chantier et par année.", 3),
                                                ("Et si la lecture échoue, le fichier va dans « erreurs », pour être vérifié par une personne.", 4)]),
    ("Étape 2 : lecture automatique (OCR)", s_ocr, [("Voici une facture scannée.", 1),
                                                     ("L'OCR repère les informations importantes : le fournisseur, le numéro, la date, l'échéance, et les montants hors taxe, TVA et TTC.", 2),
                                                     ("Le robot vérifie que le hors taxe plus la TVA égale bien le TTC. Sinon, il vous alerte.", 3)]),
    ("Étape 3 : le classeur Excel", s_excel, [("Chaque facture devient une ligne dans le classeur Excel.", 1),
                                               ("On y ajoute le chantier concerné et le compte comptable, pour que la comptabilité soit prête.", 2),
                                               ("Excel détecte les doublons, et colore en rouge les factures dont l'échéance est dépassée.", 3),
                                               ("Un onglet d'export prépare le fichier pour votre logiciel comptable.", 4)]),
    ("Étape 4 : l'analytique de chantier", s_chantier, [("Comme chaque facture porte un code chantier, Excel additionne les coûts automatiquement.", 1),
                                                         ("Voici le budget, et le réalisé, de chaque chantier.", 2),
                                                         ("Ici, le chantier de Lyon dépasse son budget. On le voit tout de suite, et pas à la fin du mois.", 3)]),
    ("Les bonnes pratiques", s_regles, [("Quelques règles pour que tout fonctionne bien.", 0),
                                         ("Scannez en bonne qualité, à trois cents dpi, bien droit.", 1),
                                         ("Gardez un nom de fichier normalisé.", 2),
                                         ("Prévoyez toujours une validation humaine en cas de doute.", 3),
                                         ("Conservez les originaux dix ans, comme l'exige la loi.", 4),
                                         ("Et attention aux données sensibles : choisissez un OCR local, ou un service conforme au RGPD.", 5)]),
    ("Plan de mise en place", s_plan, [("Pour démarrer, comptez environ six semaines.", 0),
                                        ("Semaine un : organiser les dossiers et les noms de fichiers.", 1),
                                        ("Semaine deux : construire le classeur Excel.", 2),
                                        ("Semaines trois et quatre : brancher l'automatisation et l'OCR.", 3),
                                        ("Semaines cinq et six : tableaux de bord, tests, puis mise en service.", 4),
                                        ("Je peux vous préparer le classeur Excel modèle et le workflow n8n. Merci d'avoir regardé.", 5)]),
]

clips = []
for si, (title, fn, lines) in enumerate(SCENES):
    for text, step in lines:
        clips.append((si, title, fn, text, step))

# ---------------------------------------------------------------- TTS
items = [{"file": os.path.join(BUILD, f"a{i:02d}.wav"), "text": c[3].replace("n8n", "n huit n")} for i, c in enumerate(clips)]
jp = os.path.join(BUILD, "tts.json")
with open(jp, "w", encoding="utf-8-sig") as fh:
    json.dump(items, fh, ensure_ascii=False)
with open(PS1, "w", encoding="utf-8") as fh:
    fh.write('param($jsonPath)\nAdd-Type -AssemblyName System.Speech\n'
             '$items = Get-Content -Raw -Encoding UTF8 $jsonPath | ConvertFrom-Json\n'
             '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n'
             '$s.SelectVoice("Microsoft Hortense Desktop")\n$s.Rate = -1\n'
             'foreach($it in $items){ $s.SetOutputToWaveFile($it.file); $s.Speak($it.text); $s.SetOutputToNull() }\n'
             '$s.Dispose()\n')
subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, jp], check=True)

# ---------------------------------------------------------------- render + encode
segs = []
total = len(clips)
for i, (si, title, fn, text, step) in enumerate(clips):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    if title:
        tl(d, 80, 85, title, F(62, True))
        d.rectangle([80, 135, 380, 141], fill=ACC)
    fn(d, step)
    cf = F(42)
    lines = wrap(d, text, cf, 1650)
    d.rectangle([0, 905, W, 1062], fill=(2, 6, 23))
    tc(d, W // 2, 983, "\n".join(lines), cf, TXT, lh=56)
    d.rectangle([0, 1068, int(W * (i + 1) / total), H], fill=ACC)
    png = os.path.join(BUILD, f"f{i:02d}.png")
    im.save(png)
    wav = os.path.join(BUILD, f"a{i:02d}.wav")
    with wave.open(wav) as wf:
        dur = wf.getnframes() / wf.getframerate() + 0.7
    seg = os.path.join(BUILD, f"s{i:02d}.mp4")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-loop", "1", "-framerate", "25", "-i", png, "-i", wav,
                    "-t", f"{dur:.2f}", "-af", "apad", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", seg], check=True)
    segs.append(seg)

lst = os.path.join(BUILD, "list.txt")
with open(lst, "w", encoding="utf-8") as fh:
    for s_ in segs:
        fh.write("file '" + s_.replace("\\", "/") + "'\n")
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", FINAL], check=True)
print("OK", FINAL, os.path.getsize(FINAL) // 1024, "Ko", total, "clips")
