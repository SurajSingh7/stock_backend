import mongoose from "mongoose";
import StockFieldDefinitionModel from "../models/stock.field.definition.model.js";
import dotenv from "dotenv";
dotenv.config();

const SEED_DATA = [
  {
    code: "ram",
    label: "RAM",
    inputType: "dropdown",
    optionsSource: "RAM_SIZES",
    isRequired: false,
    isFilterable: true,
  },
  {
    code: "storage",
    label: "Storage",
    inputType: "dropdown",
    optionsSource: "STORAGE_SIZES",
    isRequired: false,
    isFilterable: true,
  },
  {
    code: "imei",
    label: "IMEI Number",
    inputType: "text",
    optionsSource: null,
    isRequired: true,
    isFilterable: false,
  },
  {
    code: "serial_no",
    label: "Serial Number",
    inputType: "text",
    optionsSource: null,
    isRequired: false,
    isFilterable: false,
  },
  {
    code: "color",
    label: "Color",
    inputType: "dropdown",
    optionsSource: "COLORS",
    isRequired: false,
    isFilterable: true,
  },
  {
    code: "warranty_period",
    label: "Warranty Period",
    inputType: "dropdown",
    optionsSource: "WARRANTY_PERIODS",
    isRequired: false,
    isFilterable: false,
  },
  {
    code: "packet_no",
    label: "Packet Number",
    inputType: "text",
    optionsSource: null,
    isRequired: false,
    isFilterable: false,
  },
];

export const seedFieldDefinitions = async () => {
  try {
    let seeded = 0;
    let skipped = 0;

    for (const item of SEED_DATA) {
      const exists = await StockFieldDefinitionModel.findOne({ code: item.code }).lean();
      if (exists) {
        skipped++;
        continue;
      }
      await StockFieldDefinitionModel.create(item);
      seeded++;
    }

    console.info(`Stock field definitions seeded: ${seeded} created, ${skipped} skipped`);
    return { seeded, skipped };
  } catch (error) {
    console.error("Error seeding stock field definitions:", error);
    throw error;
  }
};

// ─── Run as standalone script ─────────────────────────────────────────────────
// node stock/seeders/stock.field.definition.seeder.js
if (process.argv[1].includes("stock.field.definition.seeder")) {
  const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/erp";
  // Sample fields (ram, imei, serial_no…) for a fresh dev database only. Run
  // against production it would add duplicates of the real fields there.
  const host = MONGO_URI.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?,]/)[0];
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    console.error(`Refusing: field-definition sample seeder runs on localhost only (target: ${host}).`);
    process.exit(1);
  }
  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      await seedFieldDefinitions();
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("DB connection error:", err);
      process.exit(1);
    });
}
