const $ = s => document.querySelector(s);
let menus = [], restaurantId = null, quantities = {};

function euro(cents){return (cents/100).toLocaleString("de-AT",{style:"currency",currency:"EUR"});}
async function api(url, options={}) {
  const response = await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:"Ungültige Serverantwort"}));
  if(!response.ok) throw new Error(data.error || "Ein Fehler ist aufgetreten.");
  return data;
}
function currentMenu(){return menus.find(m=>m.id===restaurantId);}
function renderRestaurants(){
  $("#restaurants").innerHTML = menus.map(m=>`<button type="button" class="restaurant ${m.id===restaurantId?"selected":""}" data-id="${m.id}"><span><strong>${esc(m.name)}</strong></span><small>Speisekarte ansehen</small></button>`).join("");
  document.querySelectorAll(".restaurant").forEach(b=>b.addEventListener("click",()=>{restaurantId=b.dataset.id;quantities={};renderRestaurants();renderMenu();renderCart();}));
}
function renderMenu(){
  const m=currentMenu();
  if(!m){$("#menu").innerHTML='<p class="muted">Bitte wähle zuerst ein Restaurant.</p>';return;}
  $("#menu").innerHTML=`<p class="muted">${esc(m.description)}</p>`+m.items.map(p=>`
    <div class="item"><div><h3>${esc(p.name)}</h3><p>${esc(p.description||"")}</p><div class="price">${euro(p.price)}</div></div>
    <div class="qty"><button type="button" data-minus="${p.id}" aria-label="Weniger">−</button><span>${quantities[p.id]||0}</span><button type="button" data-plus="${p.id}" aria-label="Mehr">+</button></div></div>`).join("");
  document.querySelectorAll("[data-plus]").forEach(b=>b.addEventListener("click",()=>{const id=b.dataset.plus;quantities[id]=Math.min(20,(quantities[id]||0)+1);renderMenu();renderCart();}));
  document.querySelectorAll("[data-minus]").forEach(b=>b.addEventListener("click",()=>{const id=b.dataset.minus;quantities[id]=Math.max(0,(quantities[id]||0)-1);renderMenu();renderCart();}));
}
function cartItems(){const m=currentMenu();if(!m)return [];return m.items.filter(p=>(quantities[p.id]||0)>0).map(p=>({...p,quantity:quantities[p.id]}));}
function renderCart(){
  const items=cartItems();const total=items.reduce((s,p)=>s+p.price*p.quantity,0);
  $("#cart").innerHTML=items.length?items.map(p=>`<div class="cart-row"><span>${p.quantity} × ${esc(p.name)}</span><strong>${euro(p.price*p.quantity)}</strong></div>`).join(""):'<p class="muted">Du hast noch nichts ausgewählt.</p>';
  $("#total").textContent=euro(total);$("#submitOrder").disabled=!items.length;
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("#submitOrder").addEventListener("click",async()=>{
  const name=$("#customerName").value.trim(), items=cartItems();
  $("#orderStatus").innerHTML="";
  if(name.length<2){$("#orderStatus").innerHTML='<div class="status">Bitte gib deinen Namen ein.</div>';return;}
  if(!restaurantId||!items.length){$("#orderStatus").innerHTML='<div class="status">Bitte wähle mindestens eine Speise.</div>';return;}
  $("#submitOrder").disabled=true;
  try{
    const result=await api("/api/orders",{method:"POST",body:JSON.stringify({name,restaurantId,items:items.map(i=>({id:i.id,quantity:i.quantity})),note:$("#note").value.trim()})});
    $("#orderStatus").innerHTML=`<div class="status"><strong>Bestellung #${result.orderId} gespeichert.</strong><br>${esc(result.message)}<br>Gesamt: ${esc(result.total)}${result.whatsappSent?"<br>WhatsApp-Benachrichtigung wurde gesendet.":""}</div>`;
    quantities={};renderMenu();renderCart();$("#note").value="";
  }catch(e){$("#orderStatus").innerHTML=`<div class="status">${esc(e.message)}</div>`;}
  finally{$("#submitOrder").disabled=false;}
});
$("#tabOrder").addEventListener("click",()=>showTab(false));
$("#tabAdmin").addEventListener("click",()=>showTab(true));
function showTab(admin){$("#orderView").classList.toggle("hidden",admin);$("#adminView").classList.toggle("hidden",!admin);$("#tabOrder").classList.toggle("active",!admin);$("#tabAdmin").classList.toggle("active",admin);$("#tabOrder").classList.toggle("secondary",admin);$("#tabAdmin").classList.toggle("secondary",!admin);}
$("#loginBtn").addEventListener("click",async()=>{
  $("#loginStatus").textContent="";
  try{await api("/api/admin/login",{method:"POST",body:JSON.stringify({username:$("#adminUser").value,password:$("#adminPass").value})});$("#loginPanel").classList.add("hidden");$("#adminOrders").classList.remove("hidden");await loadOrders();}
  catch(e){$("#loginStatus").textContent=e.message;}
});
async function loadOrders(){
  try{
    const orders=await api("/api/admin/orders");
    $("#ordersList").innerHTML=orders.length?orders.map(o=>`<article class="order"><div class="order-head"><strong>#${o.id} · ${esc(o.name)}</strong><span class="pill">${esc(o.status)}</span></div><p class="muted">${new Date(o.createdAt).toLocaleString("de-AT")} · ${esc(o.restaurant)} · Zahlung: vor Ort</p><p>${o.items.map(i=>`${i.quantity} × ${esc(i.name)}`).join("<br>")}</p><strong>Gesamt: ${esc(o.total)}</strong>${o.note?`<p>Anmerkung: ${esc(o.note)}</p>`:""}<label for="status-${o.id}">Status ändern</label><select id="status-${o.id}" data-status="${o.id}">${["Neu","In Bearbeitung","Erledigt","Storniert"].map(s=>`<option ${s===o.status?"selected":""}>${s}</option>`).join("")}</select></article>`).join(""):'<p class="muted">Noch keine Bestellungen vorhanden.</p>';
    document.querySelectorAll("[data-status]").forEach(sel=>sel.addEventListener("change",async()=>{try{await api(`/api/admin/orders/${sel.dataset.status}`,{method:"PATCH",body:JSON.stringify({status:sel.value})});await loadOrders();}catch(e){alert(e.message);}}));
  }catch(e){$("#ordersList").textContent=e.message;if(e.message.includes("Administrator")){ $("#adminOrders").classList.add("hidden");$("#loginPanel").classList.remove("hidden");}}
}
$("#refreshOrders").addEventListener("click",loadOrders);
$("#logoutBtn").addEventListener("click",async()=>{try{await api("/api/admin/logout",{method:"POST",body:"{}"});}catch{}$("#adminOrders").classList.add("hidden");$("#loginPanel").classList.remove("hidden");$("#adminPass").value="";});
(async()=>{try{menus=await api("/api/menu");restaurantId=menus[0]?.id||null;renderRestaurants();renderMenu();renderCart();}catch(e){$("#menu").innerHTML=`<p class="muted">Server nicht erreichbar: ${esc(e.message)}</p>`;}})();
