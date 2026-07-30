const fs=require('fs');
const {MongoClient}=require('d:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/ns-retail/node_modules/mongodb');
const env=fs.readFileSync('d:/projects/shopify-apps/natural-solutions/naturalsolutionsphc.com-Natural-Solution-App/ns-retail/.env','utf8');
const uri=(env.match(/^MONGODB_URI=(.*)$/m)||[])[1].trim();
const {readCSV,FILES,lc}=require('./goaffpro-csv.cjs');
(async()=>{
  const c=new MongoClient(uri,{serverSelectionTimeoutMS:20000}); await c.connect();
  const db=c.db('natural-solutions');
  const apps=await db.collection('wholesale_applications').find({},{projection:{email:1,status:1,firstName:1,lastName:1,businessName:1,phone:1,'commission.payoutMethod':1}}).toArray();
  const byEmail=new Map(); apps.forEach(a=>{if(a.email)byEmail.set(lc(a.email),a)});
  const aff=readCSV(FILES.affPhc);
  const unmatched=[];
  for(const a of aff){const e=lc(a['Email Address']); if(!byEmail.has(e)) unmatched.push({e,name:a.Name,paypal:lc(a['PayPal Email Address']),status:a.Status,code:a['Referral Code'],comm:a['Total Commission'],paid:a['Amount Paid']});}
  console.log('UNMATCHED',unmatched.length);
  unmatched.forEach(u=>console.log('  ',u.e,'|',u.name,'| status',u.status,'| code',u.code,'| earned',u.comm,'| paid',u.paid,'| paypal:',u.paypal, byEmail.has(u.paypal)?'<< PAYPAL EMAIL MATCHES AN APPLICATION':''));
  // name-based near matches
  console.log('\n-- name-based candidates for unmatched --');
  const byName=new Map(); apps.forEach(a=>{const k=lc((a.firstName||'')+' '+(a.lastName||'')); if(k.trim())byName.set(k,a)});
  unmatched.forEach(u=>{const k=lc(u.name); if(byName.has(k))console.log('  ',u.e,'→ app email',byName.get(k).email,'(name match:',u.name+')')});
  console.log('\n== existing cdo_practitioner_codes ==');
  const codes=await db.collection('cdo_practitioner_codes').find({}).toArray();
  codes.forEach(k=>console.log('  ',k.code,'|',k.practitionerEmail,'| shop',k.shop,'| disc',k.discountPercent,'| status',k.status,'| src',k.migrationSource||'-'));
  console.log('\n== existing cdo_orders shopifyOrderId ==');
  const ords=await db.collection('cdo_orders').find({},{projection:{shopifyOrderId:1,orderName:1,shop:1,placedAt:1,attributed:1,commissionAmount:1,practitionerEmail:1,migrationSource:1}}).toArray();
  ords.forEach(o=>console.log('  ',o.shop,'|',o.shopifyOrderId,'|',o.orderName));
  console.log('\n== cdo_settings ==');
  const st=await db.collection('cdo_settings').findOne({});
  console.log(JSON.stringify({defaultCommissionRate:st?.defaultCommissionRate,vendorCommissions:st?.vendorCommissions,commissionMode:st?.commissionMode},null,1));
  console.log('\n== shopify_sessions shops ==', JSON.stringify([...new Set((await db.collection('shopify_sessions').find({},{projection:{shop:1}}).toArray()).map(s=>s.shop))]));
  fs.writeFileSync('apps.json',JSON.stringify(apps.map(a=>({email:lc(a.email),status:a.status,id:String(a._id),firstName:a.firstName||'',lastName:a.lastName||'',businessName:a.businessName||'',phone:a.phone||'',payoutMethod:a.commission?.payoutMethod||''}))));
  fs.writeFileSync('existing.json',JSON.stringify({codes:codes.map(k=>({code:k.code,email:k.practitionerEmail,shop:k.shop})),orders:ords.map(o=>o.shopifyOrderId),orderRows:ords.map(o=>({shopifyOrderId:o.shopifyOrderId,orderName:o.orderName||'',shop:o.shop||'',placedAt:o.placedAt?new Date(o.placedAt).toISOString():'',attributed:o.attributed===true,commissionAmount:o.commissionAmount||0,practitionerEmail:o.practitionerEmail||'',migrationSource:o.migrationSource||''}))}));
  await c.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
