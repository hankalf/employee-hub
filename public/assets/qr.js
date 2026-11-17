(function () {
  "use strict";
  var H = window.Hub;
  var $ = function (id) { return document.getElementById(id); };
  function render(hub) {
    H.resolveLang(hub.settings);
    H.applyAppearance(hub.appearance);
    H.renderBrand($("brand"), hub);
    H.renderLangToggle($("lang-toggle"), hub.settings, function () { render(hub); });
    var logo = $("qr-logo");
    logo.hidden = !hub.logo;
    if (hub.logo) logo.src = "/logo?v=" + encodeURIComponent(hub.logo);
    $("eyebrow").textContent = H.t("qrEyebrow");
    $("title").textContent = H.pick(hub.settings.hubName) || H.t("qrTitle");
    document.title = H.t("qrTitle");
    $("qr").alt = H.t("qrAlt");
    $("back").textContent = "← " + H.t("backToHub");
    $("print").textContent = "🖨 " + H.t("qrPrint");
  }
  $("print").addEventListener("click", function () { window.print(); });
  H.fetchJson("/api/hub").then(render).catch(function () { $("title").textContent = H.t("couldNotLoad"); });
})();
