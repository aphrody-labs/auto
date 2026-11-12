// Pages publiques : le thème enregistré est appliqué avant le premier rendu par le script en ligne de chaque page ;
// ici, on suit les changements faits dans un autre onglet (application ou paramètres).
window.addEventListener("storage", (e: StorageEvent) => {
  if (e.key !== "auto-theme" && e.key !== null) return;
  const t = e.key === null ? null : e.newValue;
  const r = document.documentElement;
  r.classList.remove("dark", "light");
  if (t === "clair" || t === "sombre") {
    r.dataset.theme = t;
    r.classList.add(t === "sombre" ? "dark" : "light");
  } else delete r.dataset.theme;
});
