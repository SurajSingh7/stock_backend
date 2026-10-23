import StockAlertMessageModel from "../models/stock.alert.message.model.js";
import StockAlertEscalationModel from "../models/stock.alert.escalation.model.js";
import StockAlertRuleModel from "../models/stock.alert.rule.model.js";
import StockAlertSettingsService from "./stock.alert.settings.service.js";
import StockAlertDispatcherService, { setSenderKick } from "./stock.alert.dispatcher.service.js";
import { getAlertEvent } from "../config/alert.event.catalog.js";
import { getAlertProvider } from "../helpers/alert.providers/index.js";
import { nextOfficeTime } from "../helpers/alert.office.hours.helper.js";
import { getLogger } from "../helpers/logger.helper.js";
import StockAlertDigestService from "./stock.alert.digest.service.js";
import {
  ALERT_ESCALATION_STATUS,
  ALERT_MESSAGE_STATUS as S,
  ALERT_TRIGGER,
  ALERT_CHANNEL,
} from "../constants/stock.enums.js";

/*
  The background side of Alerts & Escalations. Runs inside the API process
  (started from app.js once Mongo is up). Every claim is an atomic
  findOneAndUpdate, so a second process — a PM2 cluster, a restart overlap —
  can run the same loops without ever sending a message or a step twice.

    sender       every few seconds, and at once when something is queued
    status poll  asks the provider what became of handed-over WhatsApp messages
    escalations  sends due steps / closes finished chains
    sweep        resolves chains whose work got done, frees crashed claims
*/
const log = getLogger(import.meta.url);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const RETRY_MINUTES = [1, 5, 15]; // after attempts 1, 2, 3 — then FAILED
const SENDER_EVERY_MS = 5000;
const STATUS_EVERY_MS = 60 * 1000;
const ESCALATION_EVERY_MS = 60 * 1000;
const SWEEP_EVERY_MS = 10 * MIN;
const CLAIM_MS = 2 * MIN;
const STATUS_WINDOW_MS = 3 * 24 * HOUR; // stop asking after 3 days

let running = false;
let senderBusy = false;
const timers = [];

// ─── Sender ─────────────────────────────────────────────────────────────────

const claimNext = () => {
  const now = new Date();
  return StockAlertMessageModel.findOneAndUpdate(
    { status: S.QUEUED, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
    { $set: { status: S.SENDING, claimedUntil: new Date(now.getTime() + CLAIM_MS) }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true }
  );
};

async function sendOne(msg) {
  // The switch may have gone OFF after this was queued.
  if (msg.trigger !== ALERT_TRIGGER.TEST && !(await StockAlertSettingsService.isChannelEnabled(msg.channel))) {
    msg.status = S.SKIPPED;
    msg.skipReason = `${msg.channel} was switched off before it went out`;
    msg.claimedUntil = null;
    msg.note(S.SKIPPED, msg.skipReason);
    return msg.save();
  }

  let result;
  try {
    const provider = getAlertProvider(msg.channel);
    if (!provider) throw Object.assign(new Error(`${msg.channel} has no sender yet`), { permanent: true });
    msg.provider = provider.name;
    result = await provider.send(msg);
  } catch (err) {
    msg.lastError = err.message;
    msg.claimedUntil = null;
    if (!err.permanent && msg.attempts <= RETRY_MINUTES.length) {
      const wait = RETRY_MINUTES[msg.attempts - 1];
      msg.status = S.QUEUED;
      msg.nextAttemptAt = new Date(Date.now() + wait * MIN);
      msg.note("RETRY", `${err.message} — next try in ${wait} min`);
    } else {
      msg.status = S.FAILED;
      msg.nextAttemptAt = null;
      msg.note(S.FAILED, err.message);
    }
    return msg.save();
  }

  msg.providerMessageId = result.providerMessageId || msg.providerMessageId;
  msg.claimedUntil = null;
  msg.lastError = "";
  msg.nextAttemptAt = null;
  applyProviderStatus(msg, result);
  msg.note(msg.status === S.SENDING ? "HANDED_OVER" : msg.status, msg.status === S.SENDING ? `to ${msg.provider}` : "");
  return msg.save();
}

function applyProviderStatus(msg, r) {
  const order = [S.SENDING, S.SENT, S.DELIVERED, S.READ];
  if (r.status === S.FAILED) {
    msg.status = S.FAILED;
    msg.lastError = r.error || "The provider could not deliver it";
    return;
  }
  // Never move backwards (a late "sent" after "read").
  if (order.indexOf(r.status) > order.indexOf(msg.status)) msg.status = r.status;
  if ([S.SENT, S.DELIVERED, S.READ].includes(msg.status) && !msg.sentAt) msg.sentAt = r.sentAt || new Date();
  if (r.deliveredAt) msg.deliveredAt = r.deliveredAt;
  if (r.readAt) msg.readAt = r.readAt;
}

export async function runSender() {
  if (senderBusy) return;
  senderBusy = true;
  try {
    // Bounded per run so one huge burst can't starve the other loops.
    for (let i = 0; i < 50; i += 1) {
      const msg = await claimNext();
      if (!msg) break;
      await sendOne(msg).catch((err) => log.error(`Alert ${msg._id} send crashed: ${err.message}`));
    }
  } finally {
    senderBusy = false;
  }
}

// ─── WhatsApp delivered / read ──────────────────────────────────────────────

export async function pollStatuses() {
  const provider = getAlertProvider(ALERT_CHANNEL.WHATSAPP);
  if (!provider?.fetchStatus) return;
  const now = Date.now();
  const due = await StockAlertMessageModel.find({
    channel: ALERT_CHANNEL.WHATSAPP,
    status: { $in: [S.SENDING, S.SENT, S.DELIVERED] },
    providerMessageId: { $ne: "" },
    claimedUntil: null,
    createdAt: { $gte: new Date(now - STATUS_WINDOW_MS) },
    $or: [{ statusCheckedAt: null }, { statusCheckedAt: { $lte: new Date(now - STATUS_EVERY_MS) } }],
  })
    .sort({ statusCheckedAt: 1 })
    .limit(50);

  for (const msg of due) {
    try {
      const before = msg.status;
      applyProviderStatus(msg, await provider.fetchStatus(msg.providerMessageId));
      msg.statusCheckedAt = new Date();
      if (msg.status !== before) msg.note(msg.status, msg.status === S.FAILED ? msg.lastError : "");
      await msg.save();
    } catch (err) {
      msg.statusCheckedAt = new Date();
      await msg.save().catch(() => {});
      log.warn(`Status check for alert ${msg._id} failed: ${err.message}`);
    }
  }
}

// ─── Escalation steps ───────────────────────────────────────────────────────

const closeChain = (chain, status, reason) =>
  StockAlertEscalationModel.updateOne(
    { _id: chain._id },
    {
      $set: { status, closedAt: new Date(), closedReason: reason, lockedUntil: null },
      $push: { history: { at: new Date(), stepIndex: chain.nextStepIndex, event: status, detail: reason } },
    }
  );

async function runOneChain(chain) {
  const rule = await StockAlertRuleModel.findOne({ _id: chain.ruleId, isActive: true, enabled: true }).lean();
  if (!rule) return closeChain(chain, ALERT_ESCALATION_STATUS.CANCELLED, "Rule switched off or deleted");
  const event = getAlertEvent(chain.eventKey);
  const doc = event ? await event.load(chain.recordId) : null;
  if (!doc) return closeChain(chain, ALERT_ESCALATION_STATUS.CANCELLED, "Record no longer exists");
  if (!event.isPending || !event.isPending(doc)) return closeChain(chain, ALERT_ESCALATION_STATUS.RESOLVED, "Work done");

  const settings = await StockAlertSettingsService.get();
  const now = new Date();

  // Due outside office hours → wait for the opening, send nothing now.
  const openAt = nextOfficeTime(now, settings.officeHours);
  if (openAt.getTime() > now.getTime() + 1000) {
    return StockAlertEscalationModel.updateOne({ _id: chain._id }, { $set: { nextDueAt: openAt, lockedUntil: null } });
  }

  const stepIndex = chain.nextStepIndex;
  const step = rule.steps[stepIndex];
  if (!step) return closeChain(chain, ALERT_ESCALATION_STATUS.FINISHED, "No more steps");

  let detail = "Step is switched off — passed over";
  if (step.enabled) {
    const res = await StockAlertDispatcherService.enqueueStep({
      rule,
      stepIndex,
      event,
      ctx: { ...event.build(doc), recordId: doc._id },
      trigger: ALERT_TRIGGER.ESCALATION,
      escalation: chain,
    });
    detail = `${res.queued} queued, ${res.skipped} skipped`;
  }

  const next = rule.steps[stepIndex + 1];
  const $push = { history: { at: now, stepIndex, event: step.enabled ? "SENT" : "PASSED", detail } };
  if (!next) {
    return StockAlertEscalationModel.updateOne(
      { _id: chain._id },
      {
        $set: { status: ALERT_ESCALATION_STATUS.FINISHED, nextStepIndex: stepIndex + 1, nextDueAt: null, closedAt: now, closedReason: "Last step sent", lockedUntil: null },
        $push,
      }
    );
  }
  return StockAlertEscalationModel.updateOne(
    { _id: chain._id },
    {
      $set: {
        nextStepIndex: stepIndex + 1,
        nextDueAt: nextOfficeTime(new Date(now.getTime() + next.afterHours * HOUR), settings.officeHours),
        lockedUntil: null,
      },
      $push,
    }
  );
}

export async function runEscalations() {
  for (let i = 0; i < 100; i += 1) {
    const now = new Date();
    const chain = await StockAlertEscalationModel.findOneAndUpdate(
      {
        status: ALERT_ESCALATION_STATUS.ACTIVE,
        nextDueAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + 5 * MIN) } },
      { sort: { nextDueAt: 1 }, new: true }
    ).lean();
    if (!chain) break;
    await runOneChain(chain).catch(async (err) => {
      log.error(`Escalation ${chain._id} failed: ${err.message}`);
      await StockAlertEscalationModel.updateOne({ _id: chain._id }, { $set: { lockedUntil: null } }).catch(() => {});
    });
  }
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export async function runSweep() {
  // A sender that died mid-call: no provider id, claim expired → try again.
  await StockAlertMessageModel.updateMany(
    { status: S.SENDING, providerMessageId: "", claimedUntil: { $lte: new Date() } },
    { $set: { status: S.QUEUED, claimedUntil: null }, $push: { log: { at: new Date(), event: "REQUEUED", detail: "Previous send attempt did not finish" } } }
  );
  await StockAlertDispatcherService.resolveSettled();
}

// ─── Start / stop ───────────────────────────────────────────────────────────

const every = (ms, fn, name) => {
  const tick = () => fn().catch((err) => log.error(`Alert ${name} loop: ${err.message}`));
  timers.push(setInterval(tick, ms));
  setTimeout(tick, 2000);
};

export function startAlertWorker() {
  if (running) return;
  if ((process.env.ALERT_WORKER_ENABLED || "true").trim().toLowerCase() === "false") {
    log.info("Alert worker disabled (ALERT_WORKER_ENABLED=false)");
    return;
  }
  running = true;
  setSenderKick(() => setImmediate(() => runSender().catch((err) => log.error(`Alert sender: ${err.message}`))));
  every(SENDER_EVERY_MS, runSender, "sender");
  every(STATUS_EVERY_MS, pollStatuses, "status");
  every(ESCALATION_EVERY_MS, runEscalations, "escalation");
  every(SWEEP_EVERY_MS, runSweep, "sweep");
  every(60 * 1000, () => StockAlertDigestService.runIfDue(), "digest");
  log.info("Alert worker started");
}

export function stopAlertWorker() {
  timers.splice(0).forEach(clearInterval);
  running = false;
}
