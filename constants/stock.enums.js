export const INPUT_TYPES = {
  TEXT: "text",
  TEXTAREA: "textarea",
  NUMBER: "number",
  DECIMAL: "decimal",
  DROPDOWN: "dropdown",
  MULTI_SELECT: "multi_select",
  DATE: "date",
  DATETIME: "datetime",
  BOOLEAN: "boolean",
  COLOR: "color",
};

export const INPUT_TYPES_ARRAY = Object.values(INPUT_TYPES);

export const TRACKING_METHODS = {
  INDIVIDUAL: "individual",
  QUANTITY: "quantity",
};

export const TRACKING_METHODS_ARRAY = Object.values(TRACKING_METHODS);

export const ITEM_STATUS = {
  AVAILABLE: "AVAILABLE",
  ALLOCATED: "ALLOCATED",
  IN_REPAIR: "IN_REPAIR",
  SCRAPPED: "SCRAPPED",
  IN_TRANSIT: "IN_TRANSIT",
};

export const ITEM_STATUS_ARRAY = Object.values(ITEM_STATUS);

export const CATEGORY_TYPES = {
  GROUP: "GROUP",
  LEAF: "LEAF",
};

export const CATEGORY_TYPES_ARRAY = Object.values(CATEGORY_TYPES);

export const PRODUCT_DEF_STATUS = {
  ACTIVE: "ACTIVE",
  DRAFT: "DRAFT",
};

export const PRODUCT_DEF_STATUS_ARRAY = Object.values(PRODUCT_DEF_STATUS);
export const UNIT_TYPES = {
  PIECES: "pieces",
  METER: "meter",
  KG: "kg",
  BOX: "box",
  LITRE: "litre",
  DOZEN: "dozen",
};

export const UNIT_TYPES_ARRAY = Object.values(UNIT_TYPES);
export const GST_RATES_ARRAY = ["0", "5", "12", "18", "28"];