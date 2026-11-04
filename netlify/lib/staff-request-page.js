// The staff request form. Reads the key from its own URL and sends it back on each call.
module.exports = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>New Maintenance Request</title>
<style>
body{margin:0;background:#cfddd8;font:16px/1.4 Arial,Helvetica,sans-serif;color:#111}
main{max-width:560px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:24px;margin:0 0 12px;text-align:center}
.warn{background:#fff;border-left:4px solid #b00020;padding:10px 12px;margin:12px 0}
label{display:block;font-weight:700;margin:16px 0 4px}
small{font-weight:400;color:#333}
input[type=text],select,textarea{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid #889;border-radius:4px;background:#fff}
textarea{min-height:110px}
.check{display:flex;gap:8px;align-items:center;font-weight:400;margin:8px 0}
button{width:100%;margin-top:22px;padding:13px;font:inherit;font-weight:700;color:#fff;background:#111;border:0;border-radius:6px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#msg{margin-top:14px;padding:12px;background:#fff;border-radius:4px;display:none}
#msg.err{border-left:4px solid #b00020}
#msg.ok{border-left:4px solid #1b7f3b}
</style></head><body><main>
<h1>New Maintenance Request</h1>
<p>For office staff. This creates the issue in Rent Manager. The Maintenance card appears in Aptly after the overnight sync.</p>
<div class="warn"><strong>EMERGENCY? DO NOT USE THIS FORM.</strong> Contact on-call right away at 865-217-6232.</div>
<form id="f" autocomplete="off">
<label for="property">Property</label>
<input type="text" id="property" list="propertyList" placeholder="Loading properties..." disabled required><datalist id="propertyList"></datalist>
<label for="unit">Unit <small>(leave blank if it's the whole property)</small></label>
<select id="unit" disabled><option value="">Pick a property first</option></select>
<div id="tenantBox"></div>
<label for="title">Short title of the issue</label>
<input type="text" id="title" maxlength="100" required>
<label for="description">Describe the problem</label>
<textarea id="description" required></textarea>
<label for="category">Category <small>(use Maintenance for HVAC and appliances)</small></label>
<select id="category" required><option value="">Select...</option><option value="4">Maintenance</option><option value="9">Plumbing</option><option value="10">Electric</option><option value="11">Exterior - Building</option><option value="12">Common Area</option><option value="13">Grounds / Landscaping</option><option value="14">Lock Out or Lock Issue</option><option value="8">Property Wide</option></select>
<label for="priority">Priority</label>
<select id="priority" required><option value="">Select...</option><option value="5">Low</option><option value="3">Medium</option><option value="4">High</option></select>
<label class="check"><input type="checkbox" id="okToEnter"> OK to enter if no one is home</label>
<label class="check"><input type="checkbox" id="hasPets"> Has pets</label>
<label for="lockbox">Lockbox code <small>(vacant units)</small></label>
<input type="text" id="lockbox">
<label for="enteredBy">Your name</label>
<input type="text" id="enteredBy" required>
<button id="go" type="submit">Submit Request</button>
</form>
<div id="msg" role="status"></div>
</main><script>
const key=new URLSearchParams(location.search).get('key')||'';
const dry=new URLSearchParams(location.search).get('dry')==='1';
const api=p=>location.pathname+'?key='+encodeURIComponent(key)+p;
const $=id=>document.getElementById(id);
let data={properties:[],units:[]};
function show(text,cls){const m=$('msg');m.textContent=text;m.className=cls;m.style.display='block';}
function selectedProperty(){const v=$('property').value.trim().toLowerCase();return data.properties.find(p=>p.name.toLowerCase()===v);}
fetch(api('&mode=lists')).then(r=>r.json()).then(d=>{
  if(d.error)throw new Error(d.error);
  data=d;
  const l=$('propertyList');
  d.properties.forEach(p=>{const o=document.createElement('option');o.value=p.name;l.appendChild(o);});
  $('property').disabled=false;$('property').placeholder='Start typing a property';
}).catch(e=>show('Could not load properties: '+e.message,'err'));
$('property').addEventListener('input',()=>{
  const p=selectedProperty(),u=$('unit');
  u.innerHTML='';$('tenantBox').innerHTML='';
  const first=document.createElement('option');first.value='';first.textContent=p?'Whole property / no unit':'Pick a property first';u.appendChild(first);
  if(p){data.units.filter(x=>x.property===p.id).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})).forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.name;u.appendChild(o);});}
  u.disabled=!p;
});
$('unit').addEventListener('change',()=>{
  const box=$('tenantBox'),id=$('unit').value;box.innerHTML='';
  if(!id)return;
  box.textContent='Looking up tenants...';
  fetch(api('&mode=tenants&unit='+id)).then(r=>r.json()).then(d=>{
    if($('unit').value!==id)return;
    box.innerHTML='';
    if(d.error)throw new Error(d.error);
    const h=document.createElement('label');h.textContent=d.tenants.length?'Tenants on this request':'No current tenant found (vacant unit)';box.appendChild(h);
    d.tenants.forEach(t=>{const l=document.createElement('label');l.className='check';const c=document.createElement('input');c.type='checkbox';c.className='tenant';c.value=t.id;c.checked=true;l.appendChild(c);l.appendChild(document.createTextNode(' '+t.name));box.appendChild(l);});
  }).catch(e=>{box.textContent='Could not load tenants: '+e.message;});
});
$('f').addEventListener('submit',ev=>{
  ev.preventDefault();
  const p=selectedProperty();
  if(!p){show('Please choose the property from the list.','err');return;}
  const go=$('go');go.disabled=true;go.textContent='Submitting...';
  const body={propertyId:p.id,unitId:$('unit').value,tenantIds:[...document.querySelectorAll('.tenant:checked')].map(c=>c.value),title:$('title').value,description:$('description').value,categoryId:$('category').value,priorityId:$('priority').value,okToEnter:$('okToEnter').checked,hasPets:$('hasPets').checked,lockbox:$('lockbox').value,enteredBy:$('enteredBy').value};
  fetch(api(dry?'&dry=1':''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).then(d=>{
    if(d.error)throw new Error(d.error);
    if(d.dry){show('PREVIEW ONLY, nothing was created: '+JSON.stringify(d.issue),'ok');go.disabled=false;go.textContent='Submit Request';return;}
    show('Created Rent Manager issue #'+d.id+'. The Maintenance card appears after the overnight sync.'+(d.linkWarning?' WARNING: '+d.linkWarning:''),d.linkWarning?'err':'ok');
    $('f').reset();$('tenantBox').innerHTML='';$('unit').disabled=true;go.disabled=false;go.textContent='Submit Request';
  }).catch(e=>{show('Not submitted: '+e.message+' Check Rent Manager before trying again.','err');go.disabled=false;go.textContent='Submit Request';});
});
</script></body></html>`;
