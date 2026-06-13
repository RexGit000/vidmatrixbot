require("dotenv").config({ override: true });
const connectDB = require("./db");
const Admin = require("./models/Admin");
const Package = require("./models/Package");
const Settings = require("./models/Settings");

// ── Seed data ─────────────────────────────────────────────────────────────────

const SEED_ADMINS = [
  { telegramId: 1632962204, username: "@endurenow", isSuperAdmin: true },
  { telegramId: 8486646787, username: null, isSuperAdmin: false },
  { telegramId: 7433937250, username: null, isSuperAdmin: false },
  { telegramId: null, username: "@Cristina0069", isSuperAdmin: false },
  { telegramId: 8394641070, username: null, isSuperAdmin: false },
];

const SEED_PACKAGES = [
  { name: "Starter",   stars: 50,   mediaCount: 6,   type: "one_time", isActive: true, order: 1 },
  { name: "Basic",     stars: 100,  mediaCount: 15,  type: "one_time", isActive: true, order: 2 },
  { name: "Standard",  stars: 200,  mediaCount: 29,  type: "one_time", isActive: true, order: 3 },
  { name: "Premium",   stars: 500,  mediaCount: 150, type: "one_time", isActive: true, order: 4 },
  { name: "Ultimate",  stars: 1000, mediaCount: 279, type: "one_time", isActive: true, order: 5 },
  { name: "Mega",      stars: 3000, mediaCount: 999, type: "one_time", isActive: true, order: 6 },
  { name: "Max",       stars: 4000, mediaCount: 1400, type: "one_time", isActive: true, order: 7 },
  {
    name: "Gold VIP",
    stars: 5000,
    mediaCount: 0,
    type: "subscription",
    dailyMediaCount: 75,
    durationDays: 0,
    durationMonths: 1,
    perks: ["Daily premium delivery"],
    isActive: true,
    order: 101,
  },
  {
    name: "Platinum VIP",
    stars: 7500,
    mediaCount: 0,
    type: "subscription",
    dailyMediaCount: 125,
    durationDays: 0,
    durationMonths: 1,
    perks: ["Daily premium delivery"],
    isActive: true,
    order: 102,
  },
  {
    name: "Ultra VIP",
    stars: 10000,
    mediaCount: 0,
    type: "subscription",
    dailyMediaCount: 200,
    durationDays: 0,
    durationMonths: 1,
    perks: ["VIP badge", "Priority access"],
    isActive: true,
    order: 103,
  },
  {
    name: "Royal VIP",
    stars: 25000,
    mediaCount: 0,
    type: "subscription",
    dailyMediaCount: 500,
    durationDays: 0,
    durationMonths: 1,
    perks: ["Exclusive content", "Royal badge", "Highest priority"],
    isActive: true,
    order: 104,
  },
];

const SEED_SETTINGS = [
  { key: "fileManagerChannel", value: null },
  { key: "updatesChannelUsername", value: null },
  { key: "referralRewardThreshold", value: 10 },
  { key: "referralRewardAmount", value: 3 },
  { key: "subscriptionCycleLastRunDayKey", value: null },
  { key: "weeklyRewardsLastProcessedWeekKey", value: null },
];

async function seedAdmins() {
  for (const data of SEED_ADMINS) {
    const query = data.telegramId
      ? { telegramId: data.telegramId }
      : { username: data.username };
    const existing = await Admin.findOne(query);
    if (!existing) {
      await Admin.create(data);
      const label = data.telegramId ?? data.username;
      console.log(
        `Seeded admin: ${label}${data.isSuperAdmin ? " (superadmin)" : ""}`,
      );
      continue;
    }
    let changed = false;
    if (data.username && existing.username !== data.username) {
      existing.username = data.username;
      changed = true;
    }
    if (data.isSuperAdmin && !existing.isSuperAdmin) {
      existing.isSuperAdmin = true;
      changed = true;
    }
    if (changed) {
      await existing.save();
      console.log(`Updated admin: ${data.telegramId ?? data.username}`);
    } else {
      console.log(`Admin already exists: ${data.telegramId ?? data.username}`);
    }
  }
}

async function seed() {
  await connectDB();

  await seedAdmins();
  if (process.argv.includes("--admins-only")) {
    console.log("\nAdmin seed complete.");
    process.exit(0);
    return;
  }

  // Packages — replace all with the current list
  await Package.deleteMany({});
  for (const data of SEED_PACKAGES) {
    await Package.create(data);
    console.log(
      `Seeded package: ${data.name} (${data.stars} stars → ${data.mediaCount} media)`,
    );
  }

  // Settings — upsert by key (don't overwrite existing values)
  for (const data of SEED_SETTINGS) {
    const existing = await Settings.findOne({ key: data.key });
    if (!existing) {
      await Settings.create(data);
      console.log(`Seeded setting: ${data.key} = ${data.value}`);
    } else {
      console.log(`Setting already exists: ${data.key}`);
    }
  }

  console.log("\nSeed complete.");
  process.exit(0);
}

module.exports = { seedAdmins };

if (require.main === module) {
  seed().catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
}
