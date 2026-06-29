export const getLogger = (url) => {
  const name = url?.split("/").pop() || "app";
  return {
    info: (msg, ...args) => console.log(`[INFO] [${name}]`, msg, ...args),
    error: (msg, ...args) => console.error(`[ERROR] [${name}]`, msg, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] [${name}]`, msg, ...args),
    debug: (msg, ...args) => console.debug(`[DEBUG] [${name}]`, msg, ...args),
  };
};
