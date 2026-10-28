/* Applies the saved theme before first paint */
(function () {
  var pref = "dark";
  try {
    pref = localStorage.getItem("zectill.theme") || "dark";
  } catch (e) {
    /* storage blocked */
  }
  var dark =
    pref === "dark" ||
    (pref === "system" &&
      window.matchMedia &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
})();
