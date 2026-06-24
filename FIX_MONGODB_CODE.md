# 🔧 FIX: Create TEST35 Code (Lowercase) in MongoDB

**Issue:** TEST35 code doesn't exist in MongoDB (codes must be lowercase)

**Fix:** Create test35 (lowercase) in MongoDB

---

## Quick Fix (Copy & Paste)

```javascript
// Open MongoDB shell and run:
use natural-solutions

// Delete any incorrect versions first:
db.cdo_practitioner_codes.deleteOne({ 
  code: { $regex: "^test35$", $options: "i" } 
})

// Create test35 (LOWERCASE):
db.cdo_practitioner_codes.insertOne({
  code: "test35",
  status: "active",
  discountPercent: 35,
  commissionRate: 0.15,
  practitionerSource: "wholesale",
  practitionerId: ObjectId("6748b46a6e0d9c00f8e95652"),
  createdAt: new Date(),
  updatedAt: new Date(),
})

// Verify it was created:
db.cdo_practitioner_codes.findOne({ code: "test35" })

// Should return:
{
  _id: ObjectId(...),
  code: "test35",           ← LOWERCASE ✅
  status: "active",
  discountPercent: 35,
  commissionRate: 0.15,
  practitionerSource: "wholesale",
  practitionerId: ObjectId("6748b46a6e0d9c00f8e95652"),
  ...
}
```

---

## Why This Matters

When user applies **"TEST35"** at checkout:

```
User enters: TEST35
   ↓
Extension validates: ApiService.verifyCode("TEST35", identity)
   ↓
Backend searches MongoDB:
  code: { $regex: "^test35$", $options: "i" }
         ↑
         Case-insensitive search finds lowercase "test35" ✅
   ↓
Found! Returns { valid: true, code: "test35", ... }
   ↓
Order placed with TEST35 discount
   ↓
Webhook extracts code from cart attribute
   ↓
Searches for "test35" in MongoDB:
  db.cdo_practitioner_codes.findOne({ 
    code: { $regex: "^test35$", $options: "i" }  ← Finds it ✅
  })
   ↓
Tags customer with code:test35 ✅
```

---

## All Codes Must Be Lowercase

Reference from existing working codes:

```javascript
// Working codes in database (all lowercase):
db.cdo_practitioner_codes.find({}).pretty()

{
  code: "durgesh_90ff1a4c",  ← Lowercase with underscore
  ...
}

{
  code: "test15",            ← Lowercase
  ...
}

{
  code: "test20",            ← Lowercase
  ...
}

{
  code: "test25",            ← Lowercase
  ...
}
```

---

## Step-by-Step Fix

### Step 1: Verify Durgesh's Practitioner ID

```javascript
db.wholesale_applications.findOne({ 
  email: "durgeshselkari@itgeeks.com" 
})

// Look for:
{
  _id: ObjectId("6748b46a6e0d9c00f8e95652"),  ← This is the ID
  email: "durgeshselkari@itgeeks.com",
  status: "approved",
  resellsProducts: true,
  ...
}
```

If ID is different, use the correct one in the insert below.

### Step 2: Create test35 Code

```javascript
db.cdo_practitioner_codes.insertOne({
  code: "test35",                              // ← LOWERCASE!
  status: "active",
  discountPercent: 35,
  commissionRate: 0.15,
  practitionerSource: "wholesale",
  practitionerId: ObjectId("6748b46a6e0d9c00f8e95652"),
  practitionerEmail: "durgeshselkari@itgeeks.com",
  createdAt: new Date(),
  updatedAt: new Date(),
})
```

### Step 3: Verify Creation

```javascript
// Should find it:
db.cdo_practitioner_codes.findOne({ code: "test35" })

// Should show:
✅ code: "test35"
✅ status: "active"
✅ discountPercent: 35
✅ commissionRate: 0.15
✅ practitionerId: [valid ID]
```

### Step 4: Update Order Referral (If Needed)

If the order was placed with wrong code, fix it:

```javascript
// Find the order:
db.cdo_orders.findOne({ 
  customerEmail: "pamale@denipl.net",
  amount: 1040  // From screenshot
})

// Update if code is wrong:
db.cdo_orders.updateOne(
  { customerEmail: "pamale@denipl.net", amount: 1040 },
  { $set: { referralCode: "test35" } }  // ← LOWERCASE
)
```

### Step 5: Update Customer Application

```javascript
db.cdo_applications.updateOne(
  { email: "pamale@denipl.net" },
  { $set: {
    "referral.code": "test35",      // ← LOWERCASE
    "referral.discountPercent": 35,
    "referral.commissionRate": 0.15,
    updatedBy: "admin"
  }}
)
```

### Step 6: Manually Tag in Shopify

```
Shopify Admin → Customers
Search: pamale@denipl.net
Tags section → Add:
  ✅ code:test35          (← LOWERCASE)
  ✅ durgeshselkari@itgeeks.com
Save
```

### Step 7: Verify Everything

```javascript
// 1. Code exists:
db.cdo_practitioner_codes.findOne({ code: "test35" })
// ✅ status: "active"

// 2. Order has test35:
db.cdo_orders.findOne({ customerEmail: "pamale@denipl.net" }, { sort: { createdAt: -1 } })
// ✅ referralCode: "test35"

// 3. Application has test35:
db.cdo_applications.findOne({ email: "pamale@denipl.net" })
// ✅ referral.code: "test35"

// 4. Shopify customer has tags:
// Via Shopify Admin → Tags section
// ✅ code:test35
// ✅ durgeshselkari@itgeeks.com
```

---

## Summary

| Item | Required | Current | Status |
|------|----------|---------|--------|
| **Code Format** | Lowercase: "test35" | Might be missing | ❌ |
| **Status** | "active" | - | ⏳ |
| **Discount %** | 35 | - | ⏳ |
| **Practitioner** | Durgesh's ID | - | ⏳ |
| **Order referralCode** | "test35" | - | ⏳ |
| **Application code** | "test35" | - | ⏳ |
| **Shopify Tags** | code:test35 | code:test15 | ❌ |

---

**After creating test35 (lowercase) and updating tags, everything will work! ✅**
