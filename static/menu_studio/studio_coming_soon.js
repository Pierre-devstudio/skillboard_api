(function(){
  const active = document.querySelector(".menu-item.active");
  const title = active ? active.textContent.trim() : "Fonctionnalité";
  const el = document.getElementById("comingSoonTitle");
  if (el) el.textContent = title;
})();