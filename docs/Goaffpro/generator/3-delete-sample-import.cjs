/* eslint-env node */
// Removes the SAMPLE/TEST GoAffPro import from the staging database.
//
// WHY THIS IS REQUIRED before committing the production import: the sample
// workbook created cdo_orders with synthetic ids legacy:goaffpro:<shop>:#1442,
// #1587, #1601, #1622, #1655, #1702, #1750, #1799 — and six of those order
// numbers are REAL orders in the production data. The importer keys idempotency
// off that synthetic id, so it reports those six real commissions as
// "already exists" and SKIPS them. Deleting the test rows is the only way those
// six commissions can migrate.
//
// Scope: ONLY records belonging to the sample practitioner
// (durgeshselkari@itgeeks.com) or carrying a legacy:goaffpro synthetic order id.
// It never touches the live-pipeline orders (#1512–#1518, real gid:// ids) or
// any production data.
//
// DRY RUN BY DEFAULT — pass --apply to actually delete.
//
//   node 3-delete-sample-import.cjs            # show what would be deleted
//   node 3-delete-sample-import.cjs --apply    # delete it

const fs = require('fs');
const path = require('path');
const NS_RETAIL = path.resolve(__dirname, '../../../ns-retail');
const { MongoClient, ObjectId } = require(path.join(NS_RETAIL, 'node_modules/mongodb'));

const APPLY = process.argv.includes('--apply');
const SAMPLE_EMAIL = 'durgeshselkari@itgeeks.com';

const env = fs.readFileSync(path.join(NS_RETAIL, '.env'), 'utf8');
const uri = (env.match(/^MONGODB_URI=(.*)$/m) || [])[1].trim();
const DB = (env.match(/^DATABASE_NAME=(.*)$/m) || [])[1]?.trim() || 'natural-solutions';

(async () => {
  console.log(`\n=== Delete SAMPLE GoAffPro import — ${APPLY ? 'APPLY (deleting)' : 'DRY RUN'} ===\n`);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(DB);

  // Orders: synthetic legacy id OR the sample practitioner. Never a real gid://.
  const orderFilter = {
    $or: [{ shopifyOrderId: /^legacy:goaffpro:/ }, { practitionerEmail: SAMPLE_EMAIL }],
    shopifyOrderId: { $not: /^gid:\/\/shopify\/Order\// },
  };
  const orders = await db.collection('cdo_orders').find(orderFilter).toArray();
  const orderIds = orders.map((o) => new ObjectId(o._id));
  console.log(`cdo_orders                        ${orders.length}`);
  orders.forEach((o) => console.log(`   ${o.orderName}  ${o.shopifyOrderId}  commission $${o.commissionAmount || 0}`));

  const targets = [
    ['cdo_commissions', { $or: [{ orderId: { $in: orderIds } }, { practitionerEmail: SAMPLE_EMAIL }] }],
    ['cdo_payouts', { practitionerEmail: SAMPLE_EMAIL }],
    ['cdo_referrals', { practitionerEmail: SAMPLE_EMAIL }],
    ['cdo_practitioner_codes', { practitionerEmail: SAMPLE_EMAIL }],
  ];
  console.log('');
  for (const [name, filter] of targets) {
    console.log(`${name.padEnd(33)} ${await db.collection(name).countDocuments(filter)}`);
  }

  // Safety assertion: the live-pipeline orders must survive untouched.
  const liveBefore = await db.collection('cdo_orders').countDocuments({ shopifyOrderId: /^gid:\/\/shopify\/Order\// });
  console.log(`\nlive-pipeline cdo_orders (gid://) that MUST survive: ${liveBefore}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply.\n');
    await client.close();
    return;
  }

  console.log('\ndeleting…');
  for (const [name, filter] of targets) {
    const res = await db.collection(name).deleteMany(filter);
    console.log(`  ${name.padEnd(33)} deleted ${res.deletedCount}`);
  }
  const res = await db.collection('cdo_orders').deleteMany(orderFilter);
  console.log(`  ${'cdo_orders'.padEnd(33)} deleted ${res.deletedCount}`);

  const liveAfter = await db.collection('cdo_orders').countDocuments({ shopifyOrderId: /^gid:\/\/shopify\/Order\// });
  console.log(`\nlive-pipeline cdo_orders still present: ${liveAfter} (was ${liveBefore})`);
  if (liveAfter !== liveBefore) {
    console.error('*** ABORTED EXPECTATION: live orders were affected. Investigate immediately. ***');
    process.exitCode = 1;
  } else {
    console.log('Sample import removed; live orders untouched. ✓\n');
  }
  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
