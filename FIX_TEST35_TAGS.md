# 🔧 FIX: TEST35 Tags Not Updated

**Issue:** Order placed with TEST35 code, but Shopify customer tags still show test15

**Status:** Diagnosing & Fixing

---

## Root Cause Analysis

The order shows **TEST35** was applied as discount, but customer tags show **test15**. This means:

❌ **Webhook didn't update tags with TEST35**

Possible reasons:
1. TEST35 code doesn't exist in MongoDB
2. Webhook processed order but couldn't find TEST35 code
3. Tag update failed silently

---

## Step 1: Check if TEST35 Code Exists

```bash
# Open MongoDB and run:
use natural-solutions

# Check if test35 exists:
db.cdo_practitioner_codes.findOne({ code: { $regex: "^test35$", $options: "i" } })

# Expected result:
{
  _id: ObjectId(...),
  code: "test35",
  status: "active",
  practitionerId: ObjectId(...),
  discountPercent: 35,
  ...
}
```

**If NOT found:** ⚠️ Create it:

```javascript
db.cdo_practitioner_codes.insertOne({
  code: "test35",
  status: "active",
  discountPercent: 35,
  commissionRate: 0.15,
  practitionerSource: "wholesale",
  practitionerId: ObjectId("YOUR_PRACTITIONER_ID"),  // Use Durgesh's ID
  createdAt: new Date(),
  updatedAt: new Date(),
})
```

---

## Step 2: Check if Order Was Created with TEST35

```bash
# Find the recent order for pamale@denipl.net:
db.cdo_orders.findOne(
  { customerEmail: "pamale@denipl.net" },
  { sort: { createdAt: -1 } }
)

# Expected:
{
  referralCode: "test35",  ← Should be test35, not test15
  customerEmail: "pamale@denipl.net",
  amount: 1600,
  commissionSnapshot: { code: "test35", ... },
  ...
}
```

**If referralCode is wrong:** 
- The order was ingested with wrong code
- The cart attribute might not have been set properly

---

## Step 3: Check Customer Application

```bash
# Check the customer's application record:
db.cdo_applications.findOne({ email: "pamale@denipl.net" })

# Expected:
{
  email: "pamale@denipl.net",
  referral: {
    code: "test35",  ← Should show test35
    discountPercent: 35,
    commissionRate: 0.15,
    ...
  },
  ...
}
```

**If referral.code is test15:**
- First order was with test15
- Second order (TEST35) created but used different reference
- Need to update the application if you want future orders to use test35

---

## Step 4: Manually Update Customer Tags

If TEST35 order was created but tags weren't updated, manually tag the customer:

```bash
# Go to Shopify Admin → Customers
# Search for: pamale@denipl.net
# Click customer to open
# Scroll to Tags section
# Add these tags:
#   - code:test35
#   - durgeshselkari@itgeeks.com
# Save

# Verify after 30 seconds - tags should appear
```

---

## Step 5: Verify Everything

After fixing, verify these conditions:

### MongoDB Check
```bash
# Order should have test35:
db.cdo_orders.findOne({ customerEmail: "pamale@denipl.net" }, { sort: { createdAt: -1 } })
# → referralCode: "test35" ✅

# Application should have test35 (if this is the customer's code):
db.cdo_applications.findOne({ email: "pamale@denipl.net" })
# → referral.code: "test35" ✅

# Code must exist:
db.cdo_practitioner_codes.findOne({ code: { $regex: "^test35$", $options: "i" } })
# → status: "active" ✅
```

### Shopify Admin Check
```
Customers → Search "pamale@denipl.net" → Open Customer
Tags section should show:
  ✅ code:test35
  ✅ durgeshselkari@itgeeks.com
```

### Portal Check
```
Practitioner Portal → Patients tab
Search: pamale@denipl.net
Should show:
  ✅ Code: test35
  ✅ Orders: 7 (or however many)
  ✅ Expand code history → Shows test35
```

---

## The Complete Fix (Step-by-Step)

### Fix 1: Ensure TEST35 Code Exists

```javascript
// MongoDB:
db.cdo_practitioner_codes.insertOne({
  code: "test35",
  status: "active",
  discountPercent: 35,
  commissionRate: 0.15,
  practitionerSource: "wholesale",
  practitionerId: ObjectId("6748b46a6e0d9c00f8e95652"),  // Durgesh's ID
  createdAt: new Date(),
  updatedAt: new Date(),
})

// OR if it exists, ensure status is "active":
db.cdo_practitioner_codes.updateOne(
  { code: { $regex: "^test35$", $options: "i" } },
  { $set: { status: "active" } }
)
```

### Fix 2: Check Order Was Ingested Correctly

If the order shows referralCode other than test35, it means the cart attribute wasn't set. Verify next order includes cart attribute.

### Fix 3: Manually Tag Customer (If Needed)

If MongoDB shows test35 but Shopify tags don't, manually add tags:

```javascript
// Shopify GraphQL Mutation:
mutation UpdateCustomerTags($input: CustomerInput!) {
  customerUpdate(input: $input) {
    customer { 
      id 
      tags 
    }
    userErrors { 
      field 
      message 
    }
  }
}

// Variables:
{
  "input": {
    "id": "gid://shopify/Customer/7044891320591",  // Customer GID
    "tags": [
      "code:test35",
      "durgeshselkari@itgeeks.com"
    ]
  }
}
```

### Fix 4: Update Customer Application (If Changing Assigned Code)

If you want future orders to use test35 instead of test15:

```javascript
db.cdo_applications.updateOne(
  { email: "pamale@denipl.net" },
  { $set: { 
    "referral.code": "test35",
    "referral.discountPercent": 35,
    "referral.commissionRate": 0.15,
    updatedBy: "admin"
  }}
)
```

---

## Why This Happened

The webhook tags customer **AFTER** order is confirmed. For tagging to work:

1. ✅ Order must be placed
2. ✅ Webhook receives order payload
3. ✅ Code extracted from cart attribute
4. ✅ Code validated in MongoDB
5. ✅ Customer tags updated

If any step fails, customer isn't tagged.

Most likely: **TEST35 code doesn't exist** → webhook can't validate → doesn't tag

---

## Verify the Fix Works

**Test with TEST35:**

1. Go to Shopify customer again
2. Check tags → Should show `code:test35` ✅
3. Go to practitioner portal
4. Check Patients tab → Customer should show TEST35 ✅
5. Click to expand → Code history shows test35 ✅

---

## Prevention: Ensure Code Exists Before Applying

**At Checkout:**
- Code is verified (validates existence)
- But customer is only tagged AFTER order

**Best Practice:**
- Always create referral codes BEFORE customer checkout
- Verify code exists: `db.cdo_practitioner_codes.findOne({ code: "test35" })`
- Ensure status is "active"
- Ensure practitioner is "approved" and "resellsProducts: true"

---

## Summary

**The Fix:**
1. ✅ Create TEST35 code if missing
2. ✅ Verify order has referralCode: "test35"
3. ✅ Check application has referral.code: "test35"
4. ✅ Manually add tags if webhook failed
5. ✅ Verify in portal

**For Future Orders:**
1. Ensure code exists in MongoDB
2. Apply at checkout (cart attribute set)
3. Place order (webhook tags automatically)
4. Verify tags appear in Shopify Admin

**All features working correctly once code exists! 🚀**
