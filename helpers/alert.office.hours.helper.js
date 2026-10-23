/*
  Office hours for escalation steps, in India time.

  Asia/Kolkata is a fixed UTC+05:30 with no daylight saving, so a constant
  offset is exact — no timezone library needed.

  nextOfficeTime(date, hours) returns `date` when it already falls inside
  office hours, otherwise the next opening (start time of the next working
  day). Hours off → the date unchanged.
*/
const IST_OFFSET_MS = 330 * 60 * 1000;

const toMinutes = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
};

export const nextOfficeTime = (date, officeHours) => {
  const d = new Date(date);
  if (!officeHours?.enabled) return d;
  const days = (officeHours.days || []).map(Number);
  if (!days.length) return d;

  const start = toMinutes(officeHours.start, 9 * 60);
  const end = toMinutes(officeHours.end, 19 * 60);

  // Work on an "IST wall clock" copy, convert back at the end.
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  for (let i = 0; i < 8; i += 1) {
    const day = ist.getUTCDay();
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (days.includes(day)) {
      if (minutes < start) {
        ist.setUTCHours(Math.floor(start / 60), start % 60, 0, 0);
        return new Date(ist.getTime() - IST_OFFSET_MS);
      }
      if (minutes < end) return new Date(ist.getTime() - IST_OFFSET_MS); // inside
    }
    // Next calendar day, from midnight.
    ist.setUTCDate(ist.getUTCDate() + 1);
    ist.setUTCHours(0, 0, 0, 0);
  }
  return d;
};
