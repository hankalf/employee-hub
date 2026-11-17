(function () {
  var q = new URLSearchParams(location.search);
  var messages = {
    wrong: "That username or password isn't right. Please try again.",
    locked: "Too many attempts. Please wait 15 minutes and try again.",
    disabled: "The admin area is turned off because ADMIN_PASSWORD isn't set on the service. Add it in Railway → Variables and redeploy.",
  };
  var code = q.get("error");
  if (code && messages[code]) {
    var el = document.getElementById("error");
    el.textContent = messages[code];
    el.hidden = false;
  }
  var u = document.getElementById("username");
  if (q.get("u")) { u.value = q.get("u"); document.getElementById("password").focus(); } else { u.focus(); }
  if (q.get("signedout")) {
    var n = document.getElementById("notice");
    n.textContent = "You've been signed out.";
    n.hidden = false;
  }
  fetch("/api/hub").then(function (r) { return r.json(); }).then(function (hub) {
    var name = (hub.settings && hub.settings.hubName && hub.settings.hubName.en) || "Employee Hub";
    document.getElementById("login-title").textContent = name + " admin";
    document.title = "Admin sign in · " + name;
    if (hub.logo) {
      var img = document.createElement("img");
      img.className = "brand-logo";
      img.alt = "";
      img.src = "/logo?v=" + encodeURIComponent(hub.logo);
      var box = document.getElementById("login-logo");
      box.replaceWith(img);
    }
  }).catch(function () {});
})();
