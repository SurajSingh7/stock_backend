import StockTestSimulatorSubscriberModel from "../../models/stock.test.simulator.model.js";
import { ASSIGNEE_KIND, ITEM_REQUEST_CHANNEL } from "../../constants/stock.enums.js";

/*
  🧪 TEST ONLY — stands in for the people API until its URL and response
  format are known (set PEOPLE_API_URL and the http provider takes over; see
  ./index.js).

  Employees are the fixed list below — codes start with TST so test data is
  easy to find and remove. Subscribers are the Request Simulator's own
  subscribers: the simulator plays the website, so the people it holds are
  the website's people, on its channel (TEST_SIMULATOR) — stock entered
  against them shows up when the simulator asks what they hold.

  TO REMOVE once the real API is live: this file, and the "mock" entry in
  ./index.js. Directory rows with source EXTERNAL and an employee code
  starting TST, or channel TEST_SIMULATOR, are test data.
*/

const TEST_EMPLOYEES = [
  { id: "TST001", name: "Rahul Sharma", department: "NOC", designation: "Network Engineer", branch: "Head Office", phone: "9800000001", email: "rahul.sharma@test.local" },
  { id: "TST002", name: "Priya Verma", department: "Field Operations", designation: "Field Technician", branch: "Head Office", phone: "9800000002", email: "priya.verma@test.local" },
  { id: "TST003", name: "Amit Kumar", department: "Field Operations", designation: "Team Lead", branch: "North Zone", phone: "9800000003", email: "amit.kumar@test.local" },
  { id: "TST004", name: "Sneha Gupta", department: "Accounts", designation: "Accountant", branch: "Head Office", phone: "9800000004", email: "sneha.gupta@test.local" },
  { id: "TST005", name: "Vikas Singh", department: "Store", designation: "Store Keeper", branch: "North Zone", phone: "9800000005", email: "vikas.singh@test.local" },
  { id: "TST006", name: "Neha Yadav", department: "Support", designation: "Support Executive", branch: "South Zone", phone: "9800000006", email: "neha.yadav@test.local" },
  { id: "TST007", name: "Rohit Mehta", department: "NOC", designation: "NOC Manager", branch: "Head Office", phone: "9800000007", email: "rohit.mehta@test.local" },
  { id: "TST008", name: "Kavita Joshi", department: "Field Operations", designation: "Field Technician", branch: "South Zone", phone: "9800000008", email: "kavita.joshi@test.local" },
];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const employeeOf = (e) => ({
  kind: ASSIGNEE_KIND.EMPLOYEE,
  externalId: e.id,
  name: e.name,
  phone: e.phone,
  email: e.email,
  employeeCode: e.id,
  extraFields: { Department: e.department, Designation: e.designation, Branch: e.branch },
});

const subscriberOf = (s) => ({
  kind: ASSIGNEE_KIND.SUBSCRIBER,
  externalId: String(s._id),
  name: s.customerName || s.username,
  phone: s.mobile || "",
  email: "",
  orderId: s.orderId,
  username: s.username,
  serviceType: s.serviceType,
  extraFields: { Address: s.address, Plan: s.plan },
});

const mockPeopleProvider = {
  name: "mock",
  isTest: true,
  // The channel subscribers found here belong to.
  channel: ITEM_REQUEST_CHANNEL.TEST_SIMULATOR,

  async search(q, { kind = null, limit = 20 } = {}) {
    const needle = String(q).trim().toLowerCase();
    const out = [];
    if (!kind || kind === ASSIGNEE_KIND.EMPLOYEE) {
      TEST_EMPLOYEES.filter((e) =>
        [e.id, e.name, e.phone, e.email, e.department].some((v) => String(v).toLowerCase().includes(needle))
      ).forEach((e) => out.push(employeeOf(e)));
    }
    if (!kind || kind === ASSIGNEE_KIND.SUBSCRIBER) {
      const rx = { $regex: escapeRegex(String(q).trim()), $options: "i" };
      const rows = await StockTestSimulatorSubscriberModel.find({
        $or: [{ orderId: rx }, { username: rx }, { customerName: rx }, { mobile: rx }],
      })
        .limit(limit)
        .lean();
      rows.forEach((s) => out.push(subscriberOf(s)));
    }
    return out.slice(0, limit);
  },

  async get(kind, externalId) {
    if (kind === ASSIGNEE_KIND.EMPLOYEE) {
      const e = TEST_EMPLOYEES.find((x) => x.id === externalId);
      return e ? employeeOf(e) : null;
    }
    if (!/^[0-9a-f]{24}$/i.test(String(externalId))) return null;
    const s = await StockTestSimulatorSubscriberModel.findById(externalId).lean();
    return s ? subscriberOf(s) : null;
  },
};

export default mockPeopleProvider;
