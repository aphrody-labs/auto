// Audit d'accessibilité exécuté dans la page (sérialisé par Playwright : aucune dépendance externe).
/** Contrôles exécutés dans la page ; renvoie la liste des défauts (vide si conforme). */
export function auditer(): string[] {
  const defauts: string[] = [];
  // Toute syntaxe CSS (rgb, color(srgb), color-mix, oklch) est ramenée en rgba par un canvas, qui la rend en sRGB.
  const toile = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  toile.canvas.width = toile.canvas.height = 1;
  const rgb = (c: string) => {
    toile.clearRect(0, 0, 1, 1);
    toile.fillStyle = "#000";
    toile.fillStyle = c;
    toile.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = toile.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  /** Fond peint sous l'élément : premier ancêtre opaque (les fonds semi-transparents sont composés). */
  const fond = (el: Element | null): number[] | null => {
    const couches: number[][] = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== "none") return null; // dégradé ou image : non mesurable ici
      const c = rgb(s.backgroundColor);
      const a = c[3] ?? 1;
      if (a > 0) couches.push([...c.slice(0, 3), a]);
      if (a >= 1) break;
    }
    let res = [255, 255, 255];
    for (const [r, g, b, a] of couches.reverse()) res = [r!, g!, b!].map((v, i) => v * a! + res[i]! * (1 - a!));
    return res;
  };
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const nom = (e: Element) =>
    (e.getAttribute("aria-label") ?? "").trim() ||
    (e.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join("")
      .trim() ||
    (e.textContent ?? "").trim() ||
    (e.getAttribute("title") ?? "").trim();

  // Contraste du texte.
  const marcheur = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const vus = new Set<Element>();
  for (let n = marcheur.nextNode(); n; n = marcheur.nextNode()) {
    const el = n.parentElement;
    if (!el || vus.has(el) || !(n.textContent ?? "").trim() || !visible(el)) continue;
    if (el.closest("[aria-hidden='true'], .visuellement-cache, [disabled], [aria-disabled='true']")) continue;
    vus.add(el);
    const s = getComputedStyle(el);
    const bg = fond(el);
    if (!bg) continue;
    const c = rgb(s.color);
    const a = c[3] ?? 1;
    const fg = c.slice(0, 3).map((v, i) => v * a + bg[i]! * (1 - a));
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const taille = parseFloat(s.fontSize);
    const grand = taille >= 24 || (taille >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (grand ? 3 : 4.5) - 0.01)
      defauts.push(
        `contraste ${ratio.toFixed(2)} « ${(n.textContent ?? "").trim().slice(0, 40)} » (${el.tagName.toLowerCase()})`,
      );
  }
  // Contrôles et champs.
  for (const e of document.querySelectorAll(
    "button, a[href], md-filled-button, md-outlined-button, md-primary-tab, [role='button'], [role='tab'], [role='menuitem']",
  ))
    if (visible(e) && !nom(e)) defauts.push(`contrôle sans nom : ${e.outerHTML.slice(0, 80)}`);
  for (const e of document.querySelectorAll("input:not([type='hidden']), select, textarea")) {
    const champ = e as HTMLInputElement;
    if (!visible(e)) continue;
    // Le placeholder ne remplace pas un libellé (WCAG 3.3.2) ; le texte des options d'un select non plus.
    const libelle =
      champ.labels?.length || (e.getAttribute("aria-label") ?? "").trim() || e.getAttribute("aria-labelledby");
    if (!libelle) defauts.push(`champ sans libellé : ${e.outerHTML.slice(0, 80)}`);
  }
  for (const e of document.querySelectorAll("img"))
    if (!e.hasAttribute("alt")) defauts.push(`image sans alt : ${e.src}`);
  if (document.documentElement.scrollWidth > innerWidth + 1)
    defauts.push(`défilement horizontal : ${document.documentElement.scrollWidth} px pour ${innerWidth} px`);
  if (!document.querySelector("h1")) defauts.push("aucun titre h1");
  return defauts;
}
