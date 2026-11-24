// HTML rendering for ShopMax. Deliberately includes the patterns that break
// naive browser agents: a blocking cookie banner, a hover mega-menu, modals,
// toasts, a shadow-DOM component, an iframe and lazy-loaded content.
import { CATEGORIES } from './data.js'

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const money = (n) => `$${Number(n).toFixed(2)}`

const STYLES = `
*{box-sizing:border-box}
body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;background:#f5f6fa;color:#1f2937}
a{color:inherit}
header{background:#0f172a;color:#fff;position:sticky;top:0;z-index:40}
.bar{display:flex;gap:18px;align-items:center;padding:12px 24px;max-width:1200px;margin:0 auto}
.bar a{color:#fff;text-decoration:none}
.brand{font-weight:800;font-size:19px;margin-right:auto}
main{max-width:1200px;margin:24px auto;padding:0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px}
.price{font-weight:700;color:#065f46;font-size:17px}
button,.btn{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:#64748b}
button.danger{background:#dc2626}
button:disabled{opacity:.5;cursor:not-allowed}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}
input,select{padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;width:100%;max-width:380px}
.alert{padding:10px 14px;border-radius:8px;margin:12px 0}
.alert.error{background:#fee2e2;color:#991b1b}.alert.success{background:#dcfce7;color:#166534}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:14px}
th a{text-decoration:none;color:#1f2937}
.toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:16px}
.toolbar input,.toolbar select{width:auto}
form.inline{display:inline}
.pagination{display:flex;gap:6px;margin:20px 0;flex-wrap:wrap}
.pagination a,.pagination span{padding:6px 11px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;text-decoration:none;font-size:14px}
.pagination .current{background:#2563eb;color:#fff;border-color:#2563eb}
/* hover mega-menu */
.menu{position:relative}
.menu-panel{display:none;position:absolute;top:100%;left:0;background:#fff;color:#1f2937;border:1px solid #e5e7eb;
  border-radius:8px;padding:12px;min-width:230px;box-shadow:0 12px 28px rgba(0,0,0,.18);z-index:50}
.menu:hover .menu-panel{display:block}
.menu-panel a{display:block;color:#1f2937;padding:7px 9px;border-radius:6px;text-decoration:none}
.menu-panel a:hover{background:#f1f5f9}
/* cookie banner — blocks the page until dismissed */
#cookie{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:100;display:flex;align-items:flex-end;justify-content:center}
#cookie .box{background:#fff;padding:22px;border-radius:12px 12px 0 0;max-width:620px;width:100%;text-align:center}
/* modal */
.modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:90;display:flex;align-items:center;justify-content:center}
.modal .box{background:#fff;padding:22px;border-radius:12px;max-width:520px;width:92%}
.hidden{display:none !important}
/* toast */
#toasts{position:fixed;right:18px;bottom:18px;z-index:120;display:flex;flex-direction:column;gap:8px}
.toast{background:#0f172a;color:#fff;padding:11px 16px;border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.25);font-size:14px}
.muted{color:#64748b;font-size:13px}
.steps{display:flex;gap:8px;margin-bottom:18px}
.steps div{padding:7px 14px;border-radius:20px;background:#e2e8f0;font-size:13px}
.steps div.active{background:#2563eb;color:#fff}
.field-note{font-size:12px;margin-top:4px;min-height:16px}
.ok{color:#166534}.bad{color:#991b1b}
`

const SCRIPTS = `
function acceptCookies(){
  document.cookie = 'cookies_ok=1; path=/';
  var c = document.getElementById('cookie'); if (c) c.remove();
}
function toast(msg){
  var box = document.getElementById('toasts'); if(!box) return;
  var t = document.createElement('div'); t.className='toast'; t.textContent=msg; box.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}
function openModal(id){ var m=document.getElementById(id); if(m) m.classList.remove('hidden'); }
function closeModal(id){ var m=document.getElementById(id); if(m) m.classList.add('hidden'); }
document.addEventListener('keydown', function(e){
  if(e.key==='Escape') document.querySelectorAll('.modal').forEach(function(m){ m.classList.add('hidden'); });
});
// Debounced async email availability check on the registration form
function wireEmailCheck(){
  var input = document.getElementById('email'); var note = document.getElementById('email-note');
  if(!input || !note) return;
  var t;
  input.addEventListener('input', function(){
    clearTimeout(t); note.textContent=''; note.className='field-note';
    var v = input.value.trim(); if(!v) return;
    note.textContent = 'Checking availability…';
    t = setTimeout(function(){
      fetch('/api/check-email?email=' + encodeURIComponent(v))
        .then(function(r){ return r.json(); })
        .then(function(d){
          note.textContent = d.available ? 'Email is available' : 'Email is already registered';
          note.className = 'field-note ' + (d.available ? 'ok' : 'bad');
        })
        .catch(function(){ note.textContent=''; });
    }, 450);
  });
}
// "Load more" lazy loading on the catalogue
function wireLoadMore(){
  var btn = document.getElementById('load-more'); if(!btn) return;
  btn.addEventListener('click', function(){
    var next = btn.dataset.next;
    btn.disabled = true; btn.textContent = 'Loading…';
    fetch('/api/products?' + next).then(function(r){ return r.json(); }).then(function(d){
      var grid = document.getElementById('product-grid');
      d.items.forEach(function(p){
        var el = document.createElement('div'); el.className='card';
        el.innerHTML = '<h3><a href="/products/'+p.id+'">'+p.name+'</a></h3>'
          + '<p class="muted">'+p.category+' · ★ '+p.rating+'</p>'
          + '<p class="price">$'+p.price.toFixed(2)+'</p>'
          + '<form method="post" action="/cart/add"><input type="hidden" name="id" value="'+p.id+'">'
          + '<button type="submit" aria-label="Add '+p.name+' to cart">Add to cart</button></form>';
        grid.appendChild(el);
      });
      if (d.nextQuery) { btn.dataset.next = d.nextQuery; btn.disabled=false; btn.textContent='Load more products'; }
      else { btn.remove(); }
    });
  });
}
// Shadow-DOM rating component
class ProductRating extends HTMLElement {
  connectedCallback(){
    var value = this.getAttribute('value') || '0';
    var s = this.attachShadow({mode:'open'});
    s.innerHTML = '<style>.wrap{display:flex;gap:8px;align-items:center;font-family:inherit}'
      + 'button{background:#f59e0b;color:#111;border:0;border-radius:6px;padding:7px 12px;cursor:pointer}'
      + '.stars{font-size:18px;color:#f59e0b}</style>'
      + '<div class="wrap"><span class="stars">★ ' + value + '</span>'
      + '<button id="rate-btn">Rate this product</button>'
      + '<span id="rated"></span></div>';
    s.getElementById('rate-btn').addEventListener('click', function(){
      s.getElementById('rated').textContent = 'Thanks for rating!';
    });
  }
}
customElements.define('product-rating', ProductRating);
document.addEventListener('DOMContentLoaded', function(){ wireEmailCheck(); wireLoadMore(); });
`

function megaMenu() {
  return `<div class="menu"><a href="#" id="categories-menu">Categories ▾</a>
    <div class="menu-panel">
      ${CATEGORIES.map((c) => `<a href="/?category=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
    </div></div>`
}

export function layout(req, title, body) {
  const flash = req.session.flash
  req.session.flash = null
  const count = req.session.cart.reduce((n, l) => n + l.qty, 0)
  const cookiesOk = /(^|;\s*)cookies_ok=1/.test(req.headers.cookie || '')
  const user = req.user

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} · ShopMax</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${STYLES}</style></head><body>
<header><div class="bar">
  <a class="brand" href="/">ShopMax</a>
  <a href="/">Products</a>
  ${megaMenu()}
  <a href="/cart">Cart (${count})</a>
  ${user ? `<a href="/orders">My orders</a>` : ''}
  ${user && user.role === 'admin' ? `<a href="/admin">Admin</a>` : ''}
  ${
    user
      ? `<span>Hi, ${esc(user.name)}</span><form class="inline" method="post" action="/logout"><button class="secondary" type="submit">Log out</button></form>`
      : `<a href="/login">Log in</a><a href="/register">Register</a>`
  }
</div></header>
<main>
${flash ? `<div class="alert ${flash.type}" role="alert">${esc(flash.text)}</div>` : ''}
${body}
</main>
<footer style="max-width:1200px;margin:40px auto;padding:0 20px" class="muted">
  <a href="/help" target="_blank" rel="noopener">Help centre (opens in a new tab)</a> · ShopMax demo
</footer>
<div id="toasts"></div>
${
  cookiesOk
    ? ''
    : `<div id="cookie"><div class="box"><h3>We use cookies</h3>
       <p class="muted">ShopMax uses cookies to keep your cart. Accept to continue browsing.</p>
       <button onclick="acceptCookies()">Accept all cookies</button>
       <button class="secondary" onclick="acceptCookies()">Reject non-essential</button></div></div>`
}
<script>${SCRIPTS}</script>
</body></html>`
}

export function productCard(p) {
  return `<div class="card">
    <h3><a href="/products/${p.id}">${esc(p.name)}</a></h3>
    <p class="muted">${esc(p.category)} · ★ ${p.rating}</p>
    <p class="price">${money(p.price)}</p>
    <form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}">
      <button type="submit" aria-label="Add ${esc(p.name)} to cart">Add to cart</button></form>
    <button class="secondary" type="button" onclick="openModal('qv-${p.id}')">Quick view</button>
    <div class="modal hidden" id="qv-${p.id}"><div class="box">
      <h2>${esc(p.name)}</h2><p>${esc(p.desc)}</p><p class="price">${money(p.price)}</p>
      <p class="muted">SKU ${esc(p.sku)} · ${p.stock > 0 ? `${p.stock} in stock` : 'Out of stock'}</p>
      <form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}">
        <button type="submit">Add to cart</button></form>
      <button class="secondary" type="button" onclick="closeModal('qv-${p.id}')">Close</button>
    </div></div>
  </div>`
}

export function pagination(page, pages, queryFor) {
  if (pages <= 1) return ''
  const out = []
  if (page > 1) out.push(`<a href="?${queryFor(page - 1)}" rel="prev">Previous</a>`)
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 2) {
      out.push(p === page ? `<span class="current" aria-current="page">${p}</span>` : `<a href="?${queryFor(p)}">${p}</a>`)
    } else if (Math.abs(p - page) === 3) out.push('<span>…</span>')
  }
  if (page < pages) out.push(`<a href="?${queryFor(page + 1)}" rel="next">Next</a>`)
  return `<nav class="pagination" aria-label="Pagination">${out.join('')}</nav>`
}
