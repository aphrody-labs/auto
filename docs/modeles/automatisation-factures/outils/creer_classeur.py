"""Génère classeur/Classeur_Factures_Fournisseurs.xlsx (dépendance : openpyxl).

Usage : python creer_classeur.py
"""
import datetime as dt
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter as L
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.chart.label import DataLabelList

OUT = str(Path(__file__).resolve().parent.parent / "classeur" / "Classeur_Factures_Fournisseurs.xlsx")
N = 1000            # capacité factures / paiements
LAST = N + 1        # dernière ligne de données (en-tête en ligne 1)

FONT = "Arial"
f_norm = Font(name=FONT, size=10)
f_bold = Font(name=FONT, size=10, bold=True)
f_head = Font(name=FONT, size=10, bold=True, color="FFFFFF")
f_in = Font(name=FONT, size=10, color="0000FF")
f_title = Font(name=FONT, size=16, bold=True, color="1F3864")
f_h2 = Font(name=FONT, size=12, bold=True, color="1F3864")
f_note = Font(name=FONT, size=9, italic=True, color="595959")
fill_in = PatternFill("solid", fgColor="1F4E79")      # en-tête : à saisir
fill_calc = PatternFill("solid", fgColor="375623")    # en-tête : calculé
fill_key = PatternFill("solid", fgColor="FFFF00")
fill_grey = PatternFill("solid", fgColor="F2F2F2")
fill_kpi = PatternFill("solid", fgColor="DDEBF7")
thin = Side(style="thin", color="BFBFBF")
box = Border(left=thin, right=thin, top=thin, bottom=thin)
EUR = '#,##0.00;[Red]-#,##0.00;"-"'
DATE = "dd/mm/yyyy"
PCT = "0.0%"

wb = Workbook()
wb.remove(wb.active)
ws_leg = wb.create_sheet("Légende")
ws_db = wb.create_sheet("Tableau_de_bord")
ws_j = wb.create_sheet("Journal")
ws_p = wb.create_sheet("Paiements")
ws_s = wb.create_sheet("Suivi")
ws_f = wb.create_sheet("Fournisseurs")
ws_c = wb.create_sheet("Chantiers")
ws_pc = wb.create_sheet("Plan_comptable")
ws_ea = wb.create_sheet("Export_compta")
ws_eb = wb.create_sheet("Export_banque")
ws_l = wb.create_sheet("Listes")
for ws, col in [(ws_j, "1F4E79"), (ws_p, "1F4E79"), (ws_s, "375623"), (ws_db, "C00000")]:
    ws.sheet_properties.tabColor = col


def header(ws, headers, fills, row=1, height=32):
    for i, (h, fl) in enumerate(zip(headers, fills), 1):
        c = ws.cell(row=row, column=i, value=h)
        c.font, c.fill, c.border = f_head, fl, box
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = height


def widths(ws, ws_widths):
    for i, w in enumerate(ws_widths, 1):
        ws.column_dimensions[L(i)].width = w


def style_range(ws, rng, font=f_norm, fmt=None, align=None):
    for row in ws[rng]:
        for c in row:
            c.font = font
            if fmt:
                c.number_format = fmt
            if align:
                c.alignment = align


def jx(col):
    """Cellule de la même ligne dans Journal (robuste à la suppression de lignes)."""
    return f"INDEX(Journal!${col}:${col},ROW())"


# ------------------------------------------------------------------ Listes
ws = ws_l
header(ws, ["Paramètre", "Valeur"], [fill_in] * 2)
params = [("Délai de paiement par défaut (jours)", 30, "0"),
          ("Compte TVA déductible", "445660", "@"),
          ("Compte fournisseur par défaut", "401000", "@"),
          ("Compte de banque", "512000", "@"),
          ("Seuil d'alerte budget (% consommé)", 0.9, "0%"),
          ("Code journal achats", "ACH", "@"),
          ("Code journal banque", "BQ", "@"),
          ("Compte d'attente (charge non renseignée)", "471000", "@")]
for i, (a, b, fmt) in enumerate(params, 2):
    ws.cell(row=i, column=1, value=a).font = f_norm
    c = ws.cell(row=i, column=2, value=b)
    c.font, c.fill, c.number_format = f_in, fill_key, fmt
    c.alignment = Alignment(horizontal="right")
ws["A11"] = "Les cellules jaunes (texte bleu) sont des hypothèses modifiables. Le délai par défaut s'applique quand le fournisseur n'a pas de délai propre et que l'échéance n'est pas lue sur la facture."
ws["A11"].font = f_note
ws["A11"].alignment = Alignment(wrap_text=True, vertical="top")
ws.merge_cells("A11:B13")
ws["D1"].value, ws["D1"].font, ws["D1"].fill, ws["D1"].border = "Modes de paiement", f_head, fill_in, box
for i, m in enumerate(["Virement", "Prélèvement", "Chèque", "Carte bancaire", "Espèces", "Traite / LCR"], 2):
    ws.cell(row=i, column=4, value=m).font = f_in
widths(ws, [46, 16, 3, 22])

# ------------------------------------------------------------------ Plan comptable
ws = ws_pc
header(ws, ["Compte", "Libellé", "Utilisation"], [fill_in] * 3)
plan = [("601000", "Achats de matières et matériaux", "Béton, bois, quincaillerie, matériaux de gros œuvre"),
        ("606000", "Achats non stockés (énergie, fournitures)", "Électricité, eau, petit outillage, EPI"),
        ("611000", "Sous-traitance", "Entreprises tierces sur chantier"),
        ("613000", "Locations", "Engins, échafaudages, bennes"),
        ("615000", "Entretien et réparations", "Maintenance matériel et véhicules"),
        ("616000", "Primes d'assurance", "Décennale, RC, tous risques chantier"),
        ("622000", "Honoraires", "Architecte, bureau d'études, géomètre"),
        ("625000", "Déplacements", "Carburant, péages, hébergement"),
        ("626000", "Frais postaux et télécommunications", "Téléphone, internet"),
        ("628000", "Divers", "Autres charges externes")]
for i, r in enumerate(plan, 2):
    for j, v in enumerate(r, 1):
        c = ws.cell(row=i, column=j, value=v)
        c.font = f_in
        if j == 1:
            c.number_format = "@"
widths(ws, [12, 46, 56])
ws.freeze_panes = "A2"
PC_LAST = 61

# ------------------------------------------------------------------ Fournisseurs
ws = ws_f
header(ws, ["Code", "Nom", "SIRET", "Délai paiement (jours)", "IBAN", "Email", "Compte tiers",
            "Facturé TTC", "Payé", "Reste dû", "Nb factures en retard"],
       [fill_in] * 7 + [fill_calc] * 4)
sup = [("F001", "Matériaux du Sud", "12345678900011", 30, "FR76 3000 0000 0000 0000 0000 001", "compta@materiaux-du-sud.example", "401001"),
       ("F002", "Énergie Pro", "12345678900029", 30, "FR76 3000 0000 0000 0000 0000 002", "factures@energie-pro.example", "401002"),
       ("F003", "Élec Plus SARL", "12345678900037", 30, "FR76 3000 0000 0000 0000 0000 003", "contact@elec-plus.example", "401003"),
       ("F004", "Loc'Engins", "12345678900045", 30, "FR76 3000 0000 0000 0000 0000 004", "compta@locengins.example", "401004")]
F_LAST = 201
for r in range(2, F_LAST + 1):
    vals = sup[r - 2] if r - 2 < len(sup) else [None] * 7
    for j, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=j, value=v)
        c.font = f_in
        if j in (3, 7):
            c.number_format = "@"
    ws.cell(row=r, column=8, value=f'=IF($A{r}="","",SUMIFS(Suivi!$J:$J,Suivi!$B:$B,$A{r}))')
    ws.cell(row=r, column=9, value=f'=IF($A{r}="","",SUMIFS(Suivi!$L:$L,Suivi!$B:$B,$A{r}))')
    ws.cell(row=r, column=10, value=f'=IF($A{r}="","",H{r}-I{r})')
    ws.cell(row=r, column=11, value=f'=IF($A{r}="","",COUNTIFS(Suivi!$B:$B,$A{r},Suivi!$N:$N,"En retard"))')
    for j in range(8, 12):
        ws.cell(row=r, column=j).font = f_norm
    for j in (8, 9, 10):
        ws.cell(row=r, column=j).number_format = EUR
widths(ws, [9, 30, 18, 12, 36, 34, 13, 14, 14, 14, 13])
ws.freeze_panes = "C2"
ws.auto_filter.ref = f"A1:K{F_LAST}"

# ------------------------------------------------------------------ Chantiers
ws = ws_c
header(ws, ["Code chantier", "Libellé", "Client", "Responsable", "Début", "Fin prévue", "Budget HT",
            "Engagé HT", "Reste budget", "% consommé", "Alerte", "Facturé TTC", "Payé TTC", "Reste à payer TTC"],
       [fill_in] * 7 + [fill_calc] * 7)
ch = [("A_AFFECTER", "Factures sans chantier (à affecter)", None, None, None, None, 0),
      ("DUPONT-2026", "Maison Dupont - extension", "M. Dupont", "J. Martin", dt.date(2026, 3, 2), dt.date(2026, 12, 18), 15000),
      ("LYON-2026", "Rénovation immeuble Lyon 3e", "SCI Rhône", "A. Bernard", dt.date(2026, 6, 15), dt.date(2027, 2, 26), 1250),
      ("MARSEILLE-2026", "Entrepôt Marseille", "Logis Med", "S. Rossi", dt.date(2026, 9, 1), dt.date(2027, 5, 14), 20000)]
C_LAST = 101
for r in range(2, C_LAST + 1):
    vals = ch[r - 2] if r - 2 < len(ch) else [None] * 7
    for j, v in enumerate(vals, 1):
        c = ws.cell(row=r, column=j, value=v)
        c.font = f_in
        if j in (5, 6):
            c.number_format = DATE
        if j == 7:
            c.number_format = EUR
    f = {8: f'=IF($A{r}="","",SUMIFS(Suivi!$H:$H,Suivi!$G:$G,$A{r}))',
         9: f'=IF($A{r}="","",IF($G{r}>0,G{r}-H{r},""))',
         10: f'=IF($A{r}="","",IF($G{r}>0,H{r}/G{r},""))',
         11: f'=IF($A{r}="","",IF($A{r}="A_AFFECTER",IF(H{r}>0,"À AFFECTER","OK"),IF($G{r}=0,"Budget ?",IF(J{r}>1,"DÉPASSEMENT",IF(J{r}>=Listes!$B$6,"Attention","OK")))))',
         12: f'=IF($A{r}="","",SUMIFS(Suivi!$J:$J,Suivi!$G:$G,$A{r}))',
         13: f'=IF($A{r}="","",SUMIFS(Suivi!$L:$L,Suivi!$G:$G,$A{r}))',
         14: f'=IF($A{r}="","",L{r}-M{r})'}
    for j, v in f.items():
        c = ws.cell(row=r, column=j, value=v)
        c.font = f_norm
        c.number_format = PCT if j == 10 else (EUR if j != 11 else "General")
widths(ws, [18, 36, 16, 16, 12, 12, 14, 14, 14, 12, 15, 14, 14, 16])
ws.freeze_panes = "C2"
red_f = PatternFill("solid", bgColor="F8CBAD", fgColor="F8CBAD")
org_f = PatternFill("solid", bgColor="FFE699", fgColor="FFE699")
grn_f = PatternFill("solid", bgColor="C6E0B4", fgColor="C6E0B4")
blu_f = PatternFill("solid", bgColor="BDD7EE", fgColor="BDD7EE")
pur_f = PatternFill("solid", bgColor="D9C3E8", fgColor="D9C3E8")
ws.conditional_formatting.add(f"K2:K{C_LAST}", CellIsRule(operator="equal", formula=['"DÉPASSEMENT"'], fill=red_f))
ws.conditional_formatting.add(f"K2:K{C_LAST}", CellIsRule(operator="equal", formula=['"À AFFECTER"'], fill=org_f))
ws.conditional_formatting.add(f"K2:K{C_LAST}", CellIsRule(operator="equal", formula=['"Attention"'], fill=org_f))
ws.conditional_formatting.add(f"K2:K{C_LAST}", CellIsRule(operator="equal", formula=['"OK"'], fill=grn_f))

# ------------------------------------------------------------------ Journal (table, saisie + n8n)
ws = ws_j
J_HEAD = ["Date facture", "Fournisseur (nom lu)", "SIRET", "N° facture", "Code chantier", "Compte charge",
          "Montant HT", "Montant TVA", "Montant TTC", "Échéance (si lue)", "Litige (O)", "Lien PDF",
          "Source", "Contrôle OCR", "Commentaire", "Date import"]
header(ws, J_HEAD, [fill_in] * len(J_HEAD))
D = dt.date
journal = [
    (D(2026, 9, 2), "Élec Plus SARL", "12345678900037", "2026-118", "DUPONT-2026", "611000", 4800, 960, 5760, None, None,
     "//SERVEUR/Scans/Traitees/DUPONT-2026/2026/2026-09-02_Elec-Plus_2026-118.pdf", "EXEMPLE", "OK", "Exemple : échéance dépassée", dt.datetime(2026, 9, 3, 8, 15)),
    (D(2026, 9, 15), "Matériaux du Sud", "12345678900011", "F-20390", "DUPONT-2026", "601000", 3200, 640, 3840, None, None,
     "//SERVEUR/Scans/Traitees/DUPONT-2026/2026/2026-09-15_Materiaux-du-Sud_F-20390.pdf", "EXEMPLE", "OK", "Exemple : soldée", dt.datetime(2026, 9, 16, 9, 2)),
    (D(2026, 10, 12), "Matériaux du Sud", "12345678900011", "F-20481", "DUPONT-2026", "601000", 1250, 250, 1500, None, None,
     "//SERVEUR/Scans/Traitees/DUPONT-2026/2026/2026-10-12_Materiaux-du-Sud_F-20481.pdf", "EXEMPLE", "OK", "Exemple : paiement partiel", dt.datetime(2026, 10, 13, 8, 40)),
    (D(2026, 10, 13), "Énergie Pro", "12345678900029", "E-77310", "LYON-2026", "606000", 380, 76, 456, None, None,
     "//SERVEUR/Scans/Traitees/LYON-2026/2026/2026-10-13_Energie-Pro_E-77310.pdf", "EXEMPLE", "OK", "Exemple : soldée", dt.datetime(2026, 10, 14, 10, 5)),
    (D(2026, 10, 14), "Matériaux du Sud", "12345678900011", "F-20481", "DUPONT-2026", "601000", 1250, 250, 1500, None, None,
     "//SERVEUR/Scans/Erreurs/2026-10-14_Materiaux-du-Sud_F-20481.pdf", "EXEMPLE", "À VÉRIFIER", "Exemple : même facture scannée deux fois", dt.datetime(2026, 10, 15, 8, 20)),
    (D(2026, 10, 15), "Loc'Engins", "12345678900045", "L-5530", "LYON-2026", "613000", 920, 184, 1104, None, None,
     "//SERVEUR/Scans/Traitees/LYON-2026/2026/2026-10-15_LocEngins_L-5530.pdf", "EXEMPLE", "OK", "Exemple : à payer", dt.datetime(2026, 10, 16, 9, 30)),
    (D(2026, 10, 18), "Quincaillerie Durand", None, "8841", None, None, 85, 17, 102, None, None,
     "//SERVEUR/Scans/Erreurs/2026-10-18_Quincaillerie-Durand_8841.pdf", "EXEMPLE", "À VÉRIFIER", "Exemple : fournisseur inconnu, chantier non lu", dt.datetime(2026, 10, 19, 14, 10)),
]
for r, row in enumerate(journal, 2):
    for j, v in enumerate(row, 1):
        ws.cell(row=r, column=j, value=v)
J_TAB_LAST = 1 + len(journal)
t = Table(displayName="tblJournal", ref=f"A1:P{J_TAB_LAST}")
t.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
ws.add_table(t)
for r in range(2, LAST + 1):
    for j in range(1, 17):
        c = ws.cell(row=r, column=j)
        c.font = f_norm
        if j in (1, 10):
            c.number_format = DATE
        elif j in (7, 8, 9):
            c.number_format = '#,##0.00'
        elif j == 16:
            c.number_format = "dd/mm/yyyy hh:mm"
        elif j in (3, 4, 5, 6):
            c.number_format = "@"
widths(ws, [13, 28, 17, 14, 18, 14, 13, 13, 13, 15, 10, 52, 11, 14, 42, 17])
ws.freeze_panes = "B2"
dv = DataValidation(type="list", formula1=f"=Chantiers!$A$2:$A${C_LAST}", allow_blank=True, errorStyle="warning",
                    errorTitle="Chantier inconnu", error="Ce code n'existe pas dans la feuille Chantiers. La facture sera classée A_AFFECTER.")
dv.add(f"E2:E{LAST}")
dv2 = DataValidation(type="list", formula1=f"=Plan_comptable!$A$2:$A${PC_LAST}", allow_blank=True, errorStyle="warning",
                     errorTitle="Compte inconnu", error="Ce compte n'existe pas dans Plan_comptable.")
dv2.add(f"F2:F{LAST}")
dv3 = DataValidation(type="list", formula1='"O"', allow_blank=True)
dv3.add(f"K2:K{LAST}")
dv4 = DataValidation(type="list", formula1='"OK,À VÉRIFIER"', allow_blank=True)
dv4.add(f"N2:N{LAST}")
for d_ in (dv, dv2, dv3, dv4):
    ws.add_data_validation(d_)

# ------------------------------------------------------------------ Paiements (table saisie + contrôle à droite)
ws = ws_p
P_HEAD = ["Date paiement", "Clé facture", "Montant payé", "Mode de paiement", "Référence bancaire", "Commentaire"]
header(ws, P_HEAD, [fill_in] * 6)
for j, h in enumerate(["Fournisseur", "Facture TTC", "Reste dû après ce paiement", "Contrôle"], 8):
    c = ws.cell(row=1, column=j, value=h)
    c.font, c.fill, c.border = f_head, fill_calc, box
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
pay = [(D(2026, 10, 10), "F001|F-20390", 3840, "Virement", "VIR-2026-1010-01", "Exemple : solde facture"),
       (D(2026, 10, 19), "F001|F-20481", 500, "Virement", "VIR-2026-1019-04", "Exemple : acompte"),
       (D(2026, 10, 20), "F002|E-77310", 456, "Prélèvement", "PRLV-2026-1020", "Exemple : prélèvement mensuel")]
for r, row in enumerate(pay, 2):
    for j, v in enumerate(row, 1):
        ws.cell(row=r, column=j, value=v)
tp = Table(displayName="tblPaiements", ref=f"A1:F{1 + len(pay)}")
tp.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
ws.add_table(tp)
K = lambda col: f"INDEX(${col}:${col},ROW())"
for r in range(2, LAST + 1):
    for j in range(1, 7):
        c = ws.cell(row=r, column=j)
        c.font = f_norm
        c.number_format = DATE if j == 1 else ('#,##0.00' if j == 3 else ("@" if j == 2 else "General"))
    ws.cell(row=r, column=8, value=f'=IF({K("B")}="","",IFERROR(INDEX(Suivi!$C:$C,MATCH({K("B")},Suivi!$D:$D,0)),"Clé inconnue"))')
    ws.cell(row=r, column=9, value=f'=IF({K("B")}="","",IFERROR(INDEX(Suivi!$J:$J,MATCH({K("B")},Suivi!$D:$D,0)),""))')
    ws.cell(row=r, column=10, value=f'=IF({K("B")}="","",IF(I{r}="","",ROUND(I{r}-SUMIFS($C:$C,$B:$B,{K("B")},$A:$A,"<="&{K("A")}),2)))')
    ws.cell(row=r, column=11, value=f'=IF({K("B")}="","",IF(H{r}="Clé inconnue","Clé inconnue",IF(J{r}<-0.005,"Trop payé",IF(J{r}<=0.005,"Soldée","Reste à payer"))))')
    for j in range(8, 12):
        ws.cell(row=r, column=j).font = f_norm
    ws.cell(row=r, column=9).number_format = EUR
    ws.cell(row=r, column=10).number_format = EUR
widths(ws, [14, 22, 14, 18, 22, 36, 3, 28, 14, 18, 16])
ws.freeze_panes = "A2"
dvp = DataValidation(type="list", formula1=f"=Suivi!$D$2:$D${LAST}", allow_blank=True, errorStyle="warning",
                     errorTitle="Clé inconnue", error="Cette clé n'existe pas dans Suivi. Choisissez une clé de la liste.")
dvp.add(f"B2:B{LAST}")
dvm = DataValidation(type="list", formula1="=Listes!$D$2:$D$20", allow_blank=True)
dvm.add(f"D2:D{LAST}")
ws.add_data_validation(dvp)
ws.add_data_validation(dvm)
ws.conditional_formatting.add(f"K2:K{LAST}", CellIsRule(operator="equal", formula=['"Soldée"'], fill=grn_f))
ws.conditional_formatting.add(f"K2:K{LAST}", CellIsRule(operator="equal", formula=['"Reste à payer"'], fill=blu_f))
ws.conditional_formatting.add(f"K2:K{LAST}", CellIsRule(operator="equal", formula=['"Trop payé"'], fill=pur_f))
ws.conditional_formatting.add(f"K2:K{LAST}", CellIsRule(operator="equal", formula=['"Clé inconnue"'], fill=red_f))

# ------------------------------------------------------------------ Suivi (toutes formules)
ws = ws_s
S_HEAD = ["N° facture", "Code fournisseur", "Fournisseur", "Clé facture", "Date facture", "Échéance", "Code chantier",
          "Montant HT", "TVA", "Montant TTC", "Contrôle montants", "Payé", "Reste dû", "Statut", "Jours de retard",
          "Dernier paiement", "Doublon", "Chantier saisi", "Mois (AAAAMM)", "Contrôle OCR", "Lien PDF", "Compté (1 = oui)"]
header(ws, S_HEAD, [fill_calc] * len(S_HEAD))
for r in range(2, LAST + 1):
    fx = {
        1: f'=IF({jx("D")}="","",{jx("D")}&"")',
        2: f'=IF($A{r}="","",IFERROR(INDEX(Fournisseurs!$A$2:$A${F_LAST},MATCH({jx("C")}&"",Fournisseurs!$C$2:$C${F_LAST},0)),IFERROR(INDEX(Fournisseurs!$A$2:$A${F_LAST},MATCH({jx("B")}&"",Fournisseurs!$B$2:$B${F_LAST},0)),"À CRÉER")))',
        3: f'=IF($A{r}="","",IFERROR(INDEX(Fournisseurs!$B$2:$B${F_LAST},MATCH($B{r},Fournisseurs!$A$2:$A${F_LAST},0)),{jx("B")}&""))',
        4: f'=IF($A{r}="","",$B{r}&"|"&$A{r})',
        5: f'=IF($A{r}="","",{jx("A")})',
        6: f'=IF($A{r}="","",IFERROR(IF({jx("J")}<>"",{jx("J")},$E{r}+IFERROR(INDEX(Fournisseurs!$D$2:$D${F_LAST},MATCH($B{r},Fournisseurs!$A$2:$A${F_LAST},0)),Listes!$B$2)),""))',
        7: f'=IF($A{r}="","",IF($R{r}="","A_AFFECTER",IF(COUNTIF(Chantiers!$A$2:$A${C_LAST},$R{r})>0,$R{r},"A_AFFECTER")))',
        8: f'=IF($A{r}="","",$V{r}*N({jx("G")}))',
        9: f'=IF($A{r}="","",$V{r}*N({jx("H")}))',
        10: f'=IF($A{r}="","",$V{r}*N({jx("I")}))',
        11: f'=IF($A{r}="","",IF(ABS($H{r}+$I{r}-$J{r})<=0.02,"OK","ÉCART"))',
        12: f'=IF($A{r}="","",$V{r}*SUMIFS(Paiements!$C:$C,Paiements!$B:$B,$D{r}))',
        13: f'=IF($A{r}="","",ROUND($J{r}-$L{r},2))',
        14: f'=IF($A{r}="","",IF($V{r}=0,"Doublon",IF({jx("K")}="O","Litige",IF($M{r}<-0.005,"Trop payé",IF($M{r}<=0.005,"Payée",IF(AND(ISNUMBER($F{r}),$F{r}<TODAY()),"En retard",IF($L{r}>0,"Partiellement payée","À payer")))))))',
        15: f'=IF($A{r}="","",IF(AND(ISNUMBER($F{r}),$M{r}>0.005),MAX(0,TODAY()-$F{r}),0))',
        16: f'=IF($A{r}="","",IF($L{r}=0,"",IFERROR(SUMPRODUCT(MAX((Paiements!$B$2:$B${LAST}=$D{r})*Paiements!$A$2:$A${LAST})),"")))',
        17: f'=IF($A{r}="","",IF(COUNTIF($D$2:$D${LAST},$D{r})>1,IF($V{r}=0,"DOUBLON (ignoré)","DOUBLON"),""))',
        18: f'=IF($A{r}="","",{jx("E")}&"")',
        19: f'=IF($A{r}="","",IF(ISNUMBER($E{r}),YEAR($E{r})*100+MONTH($E{r}),""))',
        20: f'=IF($A{r}="","",{jx("N")}&"")',
        21: f'=IF($A{r}="","",{jx("L")}&"")',
        22: f'=IF($A{r}="","",IF(COUNTIF($D$2:$D{r},$D{r})>1,0,1))',
    }
    for j, v in fx.items():
        c = ws.cell(row=r, column=j, value=v)
        c.font = f_norm
        if j in (5, 6, 16):
            c.number_format = DATE
        elif j in (8, 9, 10, 12, 13):
            c.number_format = EUR
widths(ws, [14, 11, 26, 20, 12, 12, 18, 13, 12, 13, 11, 13, 13, 19, 10, 13, 17, 18, 11, 12, 50, 10])
ws.freeze_panes = "C2"
ws.auto_filter.ref = f"A1:V{LAST}"
rng = f"N2:N{LAST}"
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"En retard"'], fill=red_f))
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Payée"'], fill=grn_f))
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Partiellement payée"'], fill=blu_f))
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Litige"'], fill=org_f))
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Trop payé"'], fill=pur_f))
ws.conditional_formatting.add(f"K2:K{LAST}", CellIsRule(operator="equal", formula=['"ÉCART"'], fill=red_f))
ws.conditional_formatting.add(f"Q2:Q{LAST}", FormulaRule(formula=['LEFT($Q2,7)="DOUBLON"'], fill=org_f))
ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Doublon"'], fill=org_f))
ws.conditional_formatting.add(f"B2:B{LAST}", CellIsRule(operator="equal", formula=['"À CRÉER"'], fill=org_f))
ws.conditional_formatting.add(f"G2:G{LAST}", CellIsRule(operator="equal", formula=['"A_AFFECTER"'], fill=org_f))
ws.conditional_formatting.add(f"T2:T{LAST}", CellIsRule(operator="equal", formula=['"À VÉRIFIER"'], fill=org_f))

# ------------------------------------------------------------------ Export compta (achats)
def export_sheet(ws, n_docs, lines_per_doc, heads, builders, helper_cols):
    header(ws, heads, [fill_calc] * len(heads))
    for r in range(2, 2 + n_docs * lines_per_doc):
        for j, v in builders(r).items():
            c = ws.cell(row=r, column=j, value=v)
            c.font = f_norm
            if j == 2:
                c.number_format = DATE
            if j in (6, 7):
                c.number_format = '#,##0.00;-#,##0.00;"-"'
            if j == 3:
                c.number_format = "@"
        for j, v in helper_cols(r).items():
            c = ws.cell(row=r, column=j, value=v)
            c.font, c.fill = Font(name=FONT, size=9, color="808080"), fill_grey
    widths(ws, [9, 12, 12, 16, 48, 14, 14, 3, 8, 8, 3, 26, 14])


ws = ws_ea
E_HEAD = ["Journal", "Date", "Compte", "Pièce", "Libellé", "Débit", "Crédit"]
S = lambda col, r: f"INDEX(Suivi!${col}:${col},$I{r}+1)"
export_sheet(
    ws, N, 3, E_HEAD,
    lambda r: {
        1: f'=IF(OR({S("A", r)}="",{S("V", r)}=0),"",Listes!$B$7)',
        2: f'=IF($A{r}="","",{S("E", r)})',
        3: f'=IF($A{r}="","",IF($J{r}=1,IF(LEN(INDEX(Journal!$F:$F,$I{r}+1))=0,Listes!$B$9,INDEX(Journal!$F:$F,$I{r}+1)),IF($J{r}=2,Listes!$B$3,IFERROR(INDEX(Fournisseurs!$G$2:$G${F_LAST},MATCH({S("B", r)},Fournisseurs!$A$2:$A${F_LAST},0)),Listes!$B$4))))',
        4: f'=IF($A{r}="","",{S("A", r)})',
        5: f'=IF($A{r}="","",{S("C", r)}&" - "&{S("A", r)})',
        6: f'=IF($A{r}="","",IF($J{r}=1,{S("H", r)},IF($J{r}=2,{S("I", r)},0)))',
        7: f'=IF($A{r}="","",IF($J{r}=3,{S("J", r)},0))',
    },
    lambda r: {9: f"=INT((ROW()-2)/3)+1", 10: f"=MOD(ROW()-2,3)+1"})
ws["I1"], ws["J1"] = "n° fact.", "ligne"
for a in ("I1", "J1"):
    ws[a].font = Font(name=FONT, size=9, bold=True, color="808080")
ws["L1"], ws["M1"] = "Contrôle équilibre", None
ws["L1"].font = f_bold
ws["L2"] = "Débit - Crédit"
ws["M2"] = f"=ROUND(SUM(F2:F{1 + N * 3})-SUM(G2:G{1 + N * 3}),2)"
ws["L3"] = "Doit valoir 0 (sinon : une facture a un écart HT + TVA ≠ TTC)."
ws["L3"].font = f_note
ws["L2"].font = f_norm
ws["M2"].font, ws["M2"].number_format = f_bold, EUR
ws.freeze_panes = "A2"

# ------------------------------------------------------------------ Export banque (règlements)
ws = ws_eb
PA = lambda col, r: f"INDEX(Paiements!${col}:${col},$I{r}+1)"
export_sheet(
    ws, N, 2, E_HEAD,
    lambda r: {
        1: f'=IF({PA("B", r)}="","",Listes!$B$8)',
        2: f'=IF($A{r}="","",{PA("A", r)})',
        3: f'=IF($A{r}="","",IF($J{r}=1,IFERROR(INDEX(Fournisseurs!$G$2:$G${F_LAST},MATCH(INDEX(Suivi!$B:$B,MATCH({PA("B", r)},Suivi!$D:$D,0)),Fournisseurs!$A$2:$A${F_LAST},0)),Listes!$B$4),Listes!$B$5))',
        4: f'=IF($A{r}="","",IF({PA("E", r)}="",{PA("B", r)},{PA("E", r)}&""))',
        5: f'=IF($A{r}="","","Règlement "&{PA("B", r)})',
        6: f'=IF($A{r}="","",IF($J{r}=1,{PA("C", r)},0))',
        7: f'=IF($A{r}="","",IF($J{r}=2,{PA("C", r)},0))',
    },
    lambda r: {9: f"=INT((ROW()-2)/2)+1", 10: f"=MOD(ROW()-2,2)+1"})
ws["I1"], ws["J1"] = "n° paie.", "ligne"
for a in ("I1", "J1"):
    ws[a].font = Font(name=FONT, size=9, bold=True, color="808080")
ws.freeze_panes = "A2"

# ------------------------------------------------------------------ Tableau de bord
ws = ws_db
ws.sheet_view.showGridLines = False
ws["A1"], ws["A1"].font = "Tableau de bord - factures fournisseurs", f_title
ws["A2"], ws["A2"].font = "Mis à jour le", f_note
ws["B2"], ws["B2"].number_format, ws["B2"].font = "=TODAY()", DATE, f_note
SA = lambda c: f"Suivi!${c}$2:${c}${LAST}"
kpis = [("Factures enregistrées", f'=COUNTIF({SA("A")},"?*")', "0"),
        ("Total facturé TTC", f"=SUM({SA('J')})", EUR),
        ("Total payé", f"=SUM({SA('L')})", EUR),
        ("Reste à payer", f'=SUMIFS({SA("M")},{SA("M")},">0.005")', EUR),
        ("dont en retard", f'=SUMIFS({SA("M")},{SA("N")},"En retard")', EUR),
        ("Nombre de factures en retard", f'=COUNTIF({SA("N")},"En retard")', "0"),
        ("À payer sous 7 jours", f'=SUMIFS({SA("M")},{SA("F")},">="&TODAY(),{SA("F")},"<="&TODAY()+7,{SA("M")},">0.005")', EUR),
        ("Factures en litige", f'=COUNTIF({SA("N")},"Litige")', "0"),
        ("À vérifier (OCR ou montants)", f'=SUMPRODUCT(({SA("A")}<>"")*((({SA("K")}="ÉCART")+({SA("T")}="À VÉRIFIER"))>0))', "0"),
        ("Doublons ignorés (à supprimer)", f'=COUNTIF({SA("Q")},"DOUBLON (ignoré)")', "0"),
        ("Factures sans chantier", f'=COUNTIF({SA("G")},"A_AFFECTER")', "0"),
        ("Fournisseurs à créer", f'=COUNTIF({SA("B")},"À CRÉER")', "0")]
ws["A3"], ws["A3"].font = "Indicateurs clés", f_h2
for i, (lab, fm, fmt) in enumerate(kpis, 4):
    a = ws.cell(row=i, column=1, value=lab)
    b = ws.cell(row=i, column=2, value=fm)
    a.font, b.font = f_norm, f_bold
    a.fill = b.fill = fill_kpi
    a.border = b.border = box
    b.number_format = fmt
# alertes
for rr_ in (8, 9, 12, 13, 14, 15):
    ws.conditional_formatting.add(f"B{rr_}", CellIsRule(operator="greaterThan", formula=["0"], font=Font(name=FONT, bold=True, color="C00000")))

ws["D3"], ws["D3"].font = "Retards par ancienneté", f_h2
for j, h in enumerate(["Tranche", "Nb", "Reste dû"], 4):
    c = ws.cell(row=4, column=j, value=h)
    c.font, c.fill, c.border, c.alignment = f_head, fill_calc, box, Alignment(horizontal="center")
aging = [("1 à 30 jours", 1, 30), ("31 à 60 jours", 31, 60), ("61 à 90 jours", 61, 90), ("Plus de 90 jours", 91, 99999)]
for i, (lab, a, b) in enumerate(aging, 5):
    ws.cell(row=i, column=4, value=lab).font = f_norm
    ws.cell(row=i, column=5, value=f'=COUNTIFS({SA("O")},">={a}",{SA("O")},"<={b}")').font = f_norm
    c = ws.cell(row=i, column=6, value=f'=SUMIFS({SA("M")},{SA("O")},">={a}",{SA("O")},"<={b}")')
    c.font, c.number_format = f_norm, EUR
    for j in (4, 5, 6):
        ws.cell(row=i, column=j).border = box

ws["D10"], ws["D10"].font = "Échéances à venir", f_h2
for j, h in enumerate(["Période", "Nb", "Reste dû"], 4):
    c = ws.cell(row=11, column=j, value=h)
    c.font, c.fill, c.border, c.alignment = f_head, fill_calc, box, Alignment(horizontal="center")
for i, (lab, a, b) in enumerate([("0 à 7 jours", 0, 7), ("8 à 14 jours", 8, 14), ("15 à 30 jours", 15, 30)], 12):
    ws.cell(row=i, column=4, value=lab).font = f_norm
    cond = f'{SA("F")},">="&TODAY()+{a},{SA("F")},"<="&TODAY()+{b},{SA("M")},">0.005"'
    ws.cell(row=i, column=5, value=f"=COUNTIFS({cond})").font = f_norm
    c = ws.cell(row=i, column=6, value=f"=SUMIFS({SA('M')},{cond})")
    c.font, c.number_format = f_norm, EUR
    for j in (4, 5, 6):
        ws.cell(row=i, column=j).border = box

ws["H3"], ws["H3"].font = "Répartition par statut", f_h2
for j, h in enumerate(["Statut", "Nb", "Montant TTC"], 8):
    c = ws.cell(row=4, column=j, value=h)
    c.font, c.fill, c.border, c.alignment = f_head, fill_calc, box, Alignment(horizontal="center")
for i, st in enumerate(["Payée", "Partiellement payée", "À payer", "En retard", "Litige", "Trop payé", "Doublon"], 5):
    ws.cell(row=i, column=8, value=st).font = f_norm
    ws.cell(row=i, column=9, value=f'=COUNTIF({SA("N")},H{i})').font = f_norm
    c = ws.cell(row=i, column=10, value=f'=SUMIFS({SA("J")},{SA("N")},H{i})')
    c.font, c.number_format = f_norm, EUR
    for j in (8, 9, 10):
        ws.cell(row=i, column=j).border = box

ws["A18"], ws["A18"].font = "Budget et coûts par chantier", f_h2
for j, h in enumerate(["Chantier", "Budget HT", "Engagé HT", "% consommé", "Alerte", "Reste à payer TTC"], 1):
    c = ws.cell(row=19, column=j, value=h)
    c.font, c.fill, c.border, c.alignment = f_head, fill_calc, box, Alignment(horizontal="center", wrap_text=True)
for i in range(20, 32):
    src = i - 18  # Chantiers ligne 2.. (A_AFFECTER inclus)
    m = {1: f'=IF(Chantiers!A{src}="","",Chantiers!A{src})', 2: f'=IF(Chantiers!A{src}="","",Chantiers!G{src})',
         3: f'=IF(Chantiers!A{src}="","",Chantiers!H{src})', 4: f'=IF(Chantiers!A{src}="","",Chantiers!J{src})',
         5: f'=IF(Chantiers!A{src}="","",Chantiers!K{src})', 6: f'=IF(Chantiers!A{src}="","",Chantiers!N{src})'}
    for j, v in m.items():
        c = ws.cell(row=i, column=j, value=v)
        c.font, c.border = f_norm, box
        c.number_format = PCT if j == 4 else (EUR if j in (2, 3, 6) else "General")
ws.conditional_formatting.add("E20:E31", CellIsRule(operator="equal", formula=['"DÉPASSEMENT"'], fill=red_f))
ws.conditional_formatting.add("E20:E31", CellIsRule(operator="equal", formula=['"Attention"'], fill=org_f))
ws.conditional_formatting.add("E20:E31", CellIsRule(operator="equal", formula=['"À AFFECTER"'], fill=org_f))
ws.conditional_formatting.add("E20:E31", CellIsRule(operator="equal", formula=['"OK"'], fill=grn_f))
ws["A32"] = "Le graphique montre les 6 premiers chantiers (A_AFFECTER inclus). Étendre la plage des séries pour en afficher plus."
ws["A32"].font = f_note

bar = BarChart()
bar.type, bar.style, bar.title = "col", 10, "Budget et coûts engagés (HT)"
bar.add_data(Reference(ws, min_col=2, max_col=3, min_row=19, max_row=25), titles_from_data=True)
bar.set_categories(Reference(ws, min_col=1, min_row=20, max_row=25))
bar.height, bar.width = 8.5, 17
ws.add_chart(bar, "H18")
pie = PieChart()
pie.title = "Factures par statut (nombre)"
pie.add_data(Reference(ws, min_col=9, min_row=4, max_row=11), titles_from_data=True)
pie.set_categories(Reference(ws, min_col=8, min_row=5, max_row=11))
pie.dataLabels = DataLabelList()
pie.dataLabels.showPercent = True
pie.height, pie.width = 7, 11
ws.add_chart(pie, "L3")
widths(ws, [34, 18, 16, 20, 16, 18, 3, 22, 8, 16])

# ------------------------------------------------------------------ Légende
ws = ws_leg
ws.sheet_view.showGridLines = False
widths(ws, [3, 30, 100])
ws["B1"], ws["B1"].font = "Classeur de suivi des factures fournisseurs et des chantiers", f_title
ws["B2"] = "Modèle prêt à l'emploi : saisie manuelle ou alimentation automatique par le workflow n8n. Les données présentes sont des EXEMPLES fictifs (colonne Source = EXEMPLE)."
ws["B2"].font = f_note
rows = [
    ("Comment ça marche", None),
    ("1. Journal", "Une ligne par facture reçue. Rempli par n8n (colonne Source = n8n) ou à la main. C'est la seule feuille de factures à alimenter."),
    ("2. Paiements", "Une ligne par règlement. Choisir la Clé facture dans la liste (format CODE FOURNISSEUR|N° FACTURE). Plusieurs paiements possibles par facture."),
    ("3. Suivi", "Calculé automatiquement : fournisseur, échéance, payé, reste dû, statut, retard, doublons. Ne pas saisir ici."),
    ("4. Tableau_de_bord", "Indicateurs, retards par ancienneté, échéances à venir, budget par chantier."),
    ("5. Fournisseurs / Chantiers", "Référentiels à tenir à jour : délai de paiement, compte tiers, budget des chantiers."),
    ("6. Export_compta / Export_banque", "Écritures prêtes à importer dans le logiciel comptable : achats (3 lignes par facture) et règlements (2 lignes par paiement)."),
    ("Statuts de paiement", None),
    ("À payer", "Échéance non atteinte, rien payé."),
    ("Partiellement payée", "Un acompte est enregistré, échéance non atteinte."),
    ("En retard", "Échéance dépassée et reste dû > 0 (même si un acompte a été versé)."),
    ("Payée", "Reste dû = 0."),
    ("Litige", "Mettre O dans la colonne Litige du Journal : la facture est suivie à part."),
    ("Trop payé", "Paiements supérieurs au TTC : à régulariser."),
    ("Code couleur", None),
    ("En-tête bleu", "Colonne à saisir, ou remplie par n8n."),
    ("En-tête vert", "Colonne calculée par formule : ne pas modifier."),
    ("Cellule jaune, texte bleu", "Hypothèse modifiable (feuille Listes)."),
    ("Règles à connaître", None),
    ("Capacité", f"{N} factures, {N} paiements, 200 fournisseurs, 100 chantiers. Au-delà, étendre les formules vers le bas."),
    ("Fournisseur reconnu", "Par SIRET d'abord, sinon par nom exact. Sinon le code affiché est À CRÉER : ajouter le fournisseur dans la feuille Fournisseurs."),
    ("Chantier inconnu", "Une facture sans code chantier valide est classée A_AFFECTER. Corriger le code chantier dans le Journal."),
    ("Échéance", "Date lue sur la facture si elle existe, sinon date de facture + délai du fournisseur (ou délai par défaut de la feuille Listes)."),
    ("Doublon", "Même clé (code fournisseur + N° facture) présente plusieurs fois : la 1re ligne compte, les suivantes passent en statut Doublon avec montants à 0 (ignorées des totaux et des exports). Les supprimer du Journal."),
    ("Suppression", "Supprimer une facture : clic droit sur la ligne du tableau Journal > Supprimer > Lignes du tableau. Ne jamais supprimer de lignes dans Suivi."),
    ("Avant d'utiliser vos données", "Supprimer les lignes EXEMPLE des tableaux Journal et Paiements, puis remplacer les fournisseurs et chantiers d'exemple."),
    ("Export comptable", "Vérifier avant import que Export_compta!M2 vaut 0 et que le tableau de bord n'affiche aucune facture À vérifier."),
]
r = 4
for a, b in rows:
    if b is None:
        c = ws.cell(row=r, column=2, value=a)
        c.font = f_h2
        r += 1
        continue
    ca, cb = ws.cell(row=r, column=2, value=a), ws.cell(row=r, column=3, value=b)
    ca.font, cb.font = f_bold, f_norm
    cb.alignment = Alignment(wrap_text=True, vertical="top")
    ca.alignment = Alignment(vertical="top")
    if a == "En-tête bleu":
        ca.fill, ca.font = fill_in, f_head
    elif a == "En-tête vert":
        ca.fill, ca.font = fill_calc, f_head
    elif a.startswith("Cellule jaune"):
        ca.fill, ca.font = fill_key, f_in
    r += 1

wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print("saved", OUT)
