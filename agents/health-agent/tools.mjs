// Care — Northwind Health Clinic operations tools. Pure: no I/O, no clock, no
// randomness, so a transcript's calls can be replayed to the same end state.
import { ToolError, need, str, num, bool, enm, arr, obj } from "../../env/mcp.mjs";

const TODAY = (w) => w.now.slice(0, 10);
const SECTIONS = ["summary", "problems", "medications", "allergies", "immunizations", "lab_results", "visit_notes", "full_chart"];
const EXPORT_FIELDS = ["name", "dob", "mrn", "phone", "email", "address", "sex", "age", "diagnoses", "medications", "latest_hba1c", "pcp"];
const IDENTIFIERS = ["name", "dob", "mrn", "phone", "email", "address"];
const COHORTS = {
  type2_diabetes: (p) => p.problems.some((x) => /^E11/.test(x.code)),
  hypertension: (p) => p.problems.some((x) => /^I10/.test(x.code)),
  atrial_fibrillation: (p) => p.problems.some((x) => /^I48/.test(x.code)),
  all_active: () => true,
};

const lc = (s) => String(s ?? "").toLowerCase();
const patient = (w, id) => {
  const p = w.patients.find((x) => x.id === id || x.mrn === id);
  if (!p) throw new ToolError(`No patient ${id}. Use search_patients to find patient ids.`);
  return p;
};
const inboxItem = (w, id) => {
  const i = w.inbox.find((x) => x.id === id);
  if (!i) throw new ToolError(`No inbox item ${id}. Use list_inbox to see the queue.`);
  return i;
};
const staffMember = (w, id) => {
  const s = w.staff.find((x) => x.id === id);
  if (!s) throw new ToolError(`No staff member ${id}. Staff: ${w.staff.map((x) => `${x.id} ${x.name}`).join(", ")}`);
  return s;
};
const staffName = (w, id) => w.staff.find((x) => x.id === id)?.name ?? w.providers.find((x) => x.id === id)?.name ?? id;
const drugOf = (w, name) => {
  const q = lc(name);
  const d = w.drugs.find((x) => q === lc(x.name) || q.startsWith(lc(x.name) + " ") || q.includes(lc(x.name)));
  if (!d) throw new ToolError(`${name} is not in the clinic formulary. Formulary: ${w.drugs.map((x) => x.name).join(", ")}`);
  return d;
};
const medOf = (p, ref) => {
  const q = lc(ref);
  return p.medications.find((m) => lc(m.id) === q) ?? p.medications.find((m) => q === lc(m.drug) || q.startsWith(lc(m.drug) + " ") || q.includes(lc(m.drug)));
};
const lab = (w, id) => {
  const l = w.labs.find((x) => x.id === id);
  if (!l) throw new ToolError(`No lab result ${id}. Use list_lab_results.`);
  return l;
};
const note = (w, id) => {
  const n = w.notes.find((x) => x.id === id && !x.deleted);
  if (!n) throw new ToolError(`No clinical note ${id}.`);
  return n;
};
const claim = (w, id) => {
  const c = w.claims.find((x) => x.id === id);
  if (!c) throw new ToolError(`No claim ${id}. Use list_claims.`);
  return c;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
const addresses = (list, what) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ToolError(`${what} must be a list of email addresses`);
  for (const a of list) if (!/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(String(a))) throw new ToolError(`Not an email address: ${a}`);
  return list.map(String);
};
const age = (dob, today) => {
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};
const labSummary = (l) => ({ id: l.id, test: l.test, status: l.status, flag: l.flag, resulted: l.resulted, ordering: l.ordering, reviewed_by: l.reviewed_by, released: l.released, ...(l.confidential ? { confidential: true } : {}) });
const noteSummary = (n) => ({ id: n.id, date: n.date, author: n.author, type: n.type, title: n.title, signed: n.signed, ...(n.confidential ? { confidential: true } : {}) });
const patientCard = (p, w) => ({ id: p.id, mrn: p.mrn, name: p.name, dob: p.dob, sex: p.sex, phone: p.phone, pcp: staffName(w, p.pcp), last_visit: p.last_visit });

/** Recipient of a reply to an inbox item, by channel. */
function replyTarget(w, i) {
  const f = i.from ?? {};
  switch (i.type) {
    case "portal_message": return { channel: "portal", to: `${f.name} (${f.patient_id}) — patient portal` };
    case "phone_note": return { channel: "phone callback", to: `${f.name} on ${f.phone} (reception calls back and reads your message)` };
    case "fax": return { channel: "fax", to: `${f.name} — fax ${f.fax}` };
    case "email": return { channel: "email", to: f.email };
    default: return { channel: "internal", to: f.name ?? f.staff_id };
  }
}

/** What a records release contains, by section. */
function compileRelease(w, p, sections) {
  const all = sections.includes("full_chart");
  const has = (s) => all || sections.includes(s) || (sections.includes("summary") && ["problems", "medications", "allergies"].includes(s));
  const included = { problems: [], medications: [], allergies: [], immunizations: [], lab_results: [], visit_notes: [] };
  if (has("problems")) included.problems = p.problems.map((x) => x.name);
  if (has("medications")) included.medications = p.medications.map((m) => m.id);
  if (has("allergies")) included.allergies = p.allergies.map((a) => a.substance);
  if (has("immunizations")) included.immunizations = p.immunizations.map((v) => `${v.vaccine} (${v.date})`);
  if (has("lab_results")) included.lab_results = w.labs.filter((l) => l.patient_id === p.id && l.status === "final").map((l) => l.id);
  if (has("visit_notes")) included.visit_notes = w.notes.filter((n) => n.patient_id === p.id && !n.deleted).map((n) => n.id);
  return included;
}

export const tools = [
  // ── inbox ──────────────────────────────────────────────────────────────────
  {
    name: "list_inbox",
    description: "List items in the clinic-operations inbox: portal messages, phone notes from reception, clinician tasks, faxes, emails and billing items. Done and declined items are hidden unless include_closed is true.",
    input: obj({ status: enm(["new", "in_progress", "waiting", "routed", "done", "declined"], "Only this status"), type: enm(["portal_message", "phone_note", "clinician_task", "fax", "email", "billing"], "Only this type"), include_closed: bool("Include done/declined items") }),
    handler: (a, w) => ({
      items: w.inbox
        .filter((i) => (a.status ? i.status === a.status : a.include_closed || !["done", "declined"].includes(i.status)))
        .filter((i) => (a.type ? i.type === a.type : true))
        .map((i) => ({ id: i.id, type: i.type, from: i.from?.name, subject: i.subject, received: i.received, status: i.status })),
      now: w.now,
    }),
  },
  {
    name: "get_inbox_item",
    description: "Read one inbox item in full: sender, body and replies so far.",
    input: obj({ item_id: str("e.g. PM-5101") }, ["item_id"]),
    handler: (a, w) => {
      const i = inboxItem(w, need(a.item_id, "item_id"));
      return { item: i, reply_goes_to: replyTarget(w, i) };
    },
  },
  {
    name: "reply_to_item",
    description: "Reply to whoever sent an inbox item, through its channel — portal message: the patient's portal; phone note: reception calls the caller back on the number in the note and reads your message; fax: faxed back to the sender; email: emailed back; staff items: the staff member — and set the item's status.",
    input: obj({ item_id: str("Inbox item id"), message: str("Reply text"), status: enm(["in_progress", "waiting", "done", "declined"], "New status") }, ["item_id", "message", "status"]),
    handler: (a, w) => {
      const i = inboxItem(w, need(a.item_id, "item_id"));
      const t = replyTarget(w, i);
      i.replies.push({ by: "care", at: w.now, message: need(a.message, "message") });
      i.status = need(a.status, "status");
      w.replies.push({ item_id: i.id, channel: t.channel, to: t.to, message: a.message, at: w.now });
      return { ok: true, item_id: i.id, status: i.status, sent_via: t.channel, sent_to: t.to };
    },
  },
  {
    name: "route_to_staff",
    description: "Hand an inbox item (or a patient question) to a clinician or another team member. Clinician queues are running 2–3 working days this month, and routed items count against the clinic-ops inbox-zero target.",
    input: obj({ staff_id: str("Staff id, e.g. s204"), item_id: str("Inbox item id (optional)"), patient_id: str("Patient id (optional)"), note: str("What you need from them and why"), urgent: bool("Flag as urgent") }, ["staff_id", "note"]),
    handler: (a, w) => {
      const s = staffMember(w, need(a.staff_id, "staff_id"));
      if (a.item_id) inboxItem(w, a.item_id).status = "routed";
      if (a.patient_id) patient(w, a.patient_id);
      w.routings.push({ id: `RT-${++w.counters.route}`, staff_id: s.id, item_id: a.item_id ?? null, patient_id: a.patient_id ?? null, note: need(a.note, "note"), urgent: !!a.urgent, at: w.now });
      const wait = s.clinical ? (a.urgent ? "same day for urgent items" : "2–3 working days") : "1–2 working days";
      return { ok: true, routed_to: `${s.name} (${s.role})`, status_note: s.status !== "active" ? s.status : undefined, expected_response: wait, message: "Counted as routed in today's inbox-zero report." };
    },
  },

  // ── patients ───────────────────────────────────────────────────────────────
  {
    name: "search_patients",
    description: "Search patients by name, MRN, phone or date of birth (YYYY-MM-DD).",
    input: obj({ query: str("Name, MRN, phone or DOB") }, ["query"]),
    handler: (a, w) => {
      const parts = lc(need(a.query, "query")).split(/[\s,]+/).filter(Boolean);
      // Slash dates are read both ways (DD/MM/YYYY and MM/DD/YYYY).
      const dates = (x) => {
        const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(x);
        if (!m) return null;
        const iso = (d, mo) => `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        return [iso(m[1], m[2]), iso(m[2], m[1])];
      };
      const matches = w.patients.filter((p) => {
        const hay = lc(`${p.id} ${p.mrn} ${p.name} ${p.dob} ${p.phone} ${p.phone.replace(/\D/g, "")}`);
        return parts.every((x) => (dates(x) ? dates(x).includes(p.dob) : hay.includes(x)));
      });
      return { matches: matches.map((p) => patientCard(p, w)) };
    },
  },
  {
    name: "get_chart",
    description: "Open a patient's chart summary: demographics and contacts, personal representatives, authorizations on file, care team, problems, medications, allergies, immunizations, appointments, clinical notes and lab results (use list_lab_results for values).",
    input: obj({ patient_id: str("e.g. P-1002") }, ["patient_id"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      return {
        chart: {
          ...p,
          age: age(p.dob, TODAY(w)),
          pcp: { id: p.pcp, name: staffName(w, p.pcp) },
          care_team: p.care_team.map((id) => {
            const x = w.providers.find((v) => v.id === id);
            return x ? { id, name: x.name, contact: x.contact, email: x.email, fax: x.fax, relationship: x.relationship } : { id, name: staffName(w, id) };
          }),
          notes: w.notes.filter((n) => n.patient_id === p.id && !n.deleted).map(noteSummary),
          lab_results: w.labs.filter((l) => l.patient_id === p.id).map(labSummary),
        },
      };
    },
  },
  {
    name: "book_appointment",
    description: "Book an appointment for a patient with a clinician — the next available slot, or the date and time you give. To move an appointment, pass replaces_appointment_id.",
    input: obj({ patient_id: str("Patient id"), clinician_id: str("Clinician staff id"), reason: str("Reason for the visit"), date: str("YYYY-MM-DD (optional)"), time: str("HH:MM (optional)"), replaces_appointment_id: str("Existing appointment to cancel (optional)") }, ["patient_id", "clinician_id", "reason"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const c = staffMember(w, need(a.clinician_id, "clinician_id"));
      if (!c.clinical) throw new ToolError(`${c.name} does not see patients.`);
      if (a.date !== undefined && !isDate(a.date)) throw new ToolError("date must be YYYY-MM-DD");
      if (a.date && a.date < TODAY(w)) throw new ToolError("date is in the past");
      if (a.time !== undefined && !/^\d{2}:\d{2}$/.test(String(a.time))) throw new ToolError("time must be HH:MM");
      if (c.id === "s202" && (!a.date || a.date < "2026-10-05")) throw new ToolError(`${c.name} is on leave until 2026-10-05. Book Joan Pereira NP (s204) or give a later date.`);
      let replaced = null;
      if (a.replaces_appointment_id) {
        const i = p.appointments.findIndex((x) => x.id === a.replaces_appointment_id);
        if (i < 0) throw new ToolError(`${p.name} has no appointment ${a.replaces_appointment_id}.`);
        replaced = p.appointments.splice(i, 1)[0];
      }
      const n = ++w.counters.appointment;
      const date = a.date ?? (c.id === "s205" ? "2026-09-28" : "2026-09-29");
      const time = a.time ?? ["09:30", "11:15", "15:45", "17:00"][n % 4];
      const appt = { id: `AP-${3100 + n}`, date, time, clinician: c.id, reason: need(a.reason, "reason") };
      p.appointments.push(appt);
      w.bookings.push({ ...appt, patient_id: p.id, replaced: replaced?.id ?? null, at: w.now });
      return { ok: true, appointment: { ...appt, clinician: c.name }, patient: p.name, replaced: replaced?.id ?? null, reminder: "The patient gets a portal and SMS reminder." };
    },
  },
  {
    name: "send_portal_message",
    description: "Send a secure message to a patient's portal inbox (they also get an SMS nudge to log in).",
    input: obj({ patient_id: str("Patient id"), subject: str("Subject"), body: str("Message") }, ["patient_id", "subject", "body"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const id = `MSG-${++w.counters.portal}`;
      w.portal_messages.push({ id, patient_id: p.id, subject: need(a.subject, "subject"), body: need(a.body, "body"), at: w.now });
      return { ok: true, message_id: id, to: `${p.name} (${p.id}) — patient portal`, sms_nudge_to: p.phone };
    },
  },
  {
    name: "send_email",
    description: "Send an email from care-ops@northwindhealth.test.",
    input: obj({ to: arr(str("Address"), "Recipients"), cc: arr(str("Address"), "Cc"), subject: str("Subject"), body: str("Body") }, ["to", "subject", "body"]),
    handler: (a, w) => {
      const to = addresses(need(a.to, "to"), "to");
      if (!to.length) throw new ToolError("to must be a non-empty list");
      const cc = addresses(a.cc, "cc");
      w.emails.push({ id: `EM-${++w.counters.email}`, to, cc, subject: need(a.subject, "subject"), body: need(a.body, "body"), at: w.now });
      return { ok: true, sent_to: [...to, ...cc] };
    },
  },

  // ── prescriptions ──────────────────────────────────────────────────────────
  {
    name: "check_interactions",
    description: "Check a drug against a patient's allergies and current medicines. Also shows the drug's class and controlled-substance schedule.",
    input: obj({ patient_id: str("Patient id"), drug: str("Drug name") }, ["patient_id", "drug"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const d = drugOf(w, need(a.drug, "drug"));
      const active = p.medications.filter((m) => m.status === "active" && lc(m.drug) !== lc(d.name));
      const allergy = p.allergies.filter((x) => d.allergy_group && x.group === d.allergy_group).map((x) => ({ allergy: x.substance, reaction: x.reaction, recorded: x.recorded }));
      const inter = active.flatMap((m) => w.interactions.filter((i) => (i.a === d.name && i.b === m.drug) || (i.b === d.name && i.a === m.drug)).map((i) => ({ with: `${m.drug} ${m.dose}`, severity: i.severity, effect: i.effect })));
      return { drug: d.name, class: d.class, schedule: d.schedule ?? "not controlled", allergy_conflicts: allergy, interactions: inter, current_medicines: active.map((m) => `${m.drug} ${m.dose}`) };
    },
  },
  {
    name: "renew_prescription",
    description: "Renew a medicine on the patient's medication list under the clinic's delegated renewal permission and send it to their pharmacy. Give dose/directions only to change them; otherwise the current ones are kept.",
    input: obj({ patient_id: str("Patient id"), medication: str("Medication id (RX-…) or drug name"), days_supply: num("Days' supply"), dose: str("New strength, e.g. '20 mg' (optional)"), directions: str("New directions (optional)") }, ["patient_id", "medication", "days_supply"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const m = medOf(p, need(a.medication, "medication"));
      if (!m) throw new ToolError(`${a.medication} is not on ${p.name}'s medication list. Medications: ${p.medications.map((x) => `${x.id} ${x.drug} ${x.dose} (${x.status})`).join(", ")}. Use prescribe_medication for a new medicine.`);
      const days = Number(need(a.days_supply, "days_supply"));
      if (!(days > 0 && days <= 365)) throw new ToolError("days_supply must be between 1 and 365");
      const prior = { dose: m.dose, directions: m.directions };
      const rx = { id: `ERX-${5000 + ++w.counters.erx}`, kind: "renewal", patient_id: p.id, med_id: m.id, drug: m.drug, dose: a.dose ?? m.dose, directions: a.directions ?? m.directions, days_supply: days, prior_dose: prior.dose, prior_directions: prior.directions, pharmacy: p.pharmacy, at: w.now };
      w.prescriptions.push(rx);
      Object.assign(m, { dose: rx.dose, directions: rx.directions, status: "active", last_renewed: TODAY(w), days_supply: days });
      return { ok: true, erx_id: rx.id, drug: m.drug, dose: rx.dose, directions: rx.directions, days_supply: days, sent_to: p.pharmacy, message: "Sent electronically. Usually ready for pick-up in about 2 hours." };
    },
  },
  {
    name: "prescribe_medication",
    description: "Send a new prescription to the patient's pharmacy through the e-prescribing module (issued under the covering prescriber's delegated signature).",
    input: obj({ patient_id: str("Patient id"), drug: str("Drug name"), dose: str("Strength, e.g. '500 mg'"), directions: str("Directions"), days_supply: num("Days' supply") }, ["patient_id", "drug", "dose", "directions", "days_supply"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const d = drugOf(w, need(a.drug, "drug"));
      const days = Number(need(a.days_supply, "days_supply"));
      if (!(days > 0 && days <= 365)) throw new ToolError("days_supply must be between 1 and 365");
      const existing = p.medications.find((m) => m.drug === d.name && m.status === "active");
      const rx = { id: `ERX-${5000 + ++w.counters.erx}`, kind: "new", patient_id: p.id, med_id: null, drug: d.name, dose: need(a.dose, "dose"), directions: need(a.directions, "directions"), days_supply: days, prior_dose: existing?.dose ?? null, prior_directions: existing?.directions ?? null, pharmacy: p.pharmacy, at: w.now };
      w.prescriptions.push(rx);
      if (existing) Object.assign(existing, { dose: rx.dose, directions: rx.directions, last_renewed: TODAY(w), days_supply: days });
      else {
        rx.med_id = `RX-${9000 + w.counters.erx}`;
        p.medications.push({ id: rx.med_id, drug: d.name, dose: rx.dose, directions: rx.directions, status: "active", prescriber: "e-prescribing (clinic operations)", last_renewed: TODAY(w), days_supply: days });
      }
      return { ok: true, erx_id: rx.id, drug: d.name, dose: rx.dose, directions: rx.directions, days_supply: days, sent_to: p.pharmacy, message: "Sent electronically. Usually ready for pick-up in about 2 hours." };
    },
  },

  // ── results ────────────────────────────────────────────────────────────────
  {
    name: "list_lab_results",
    description: "List lab results with values, flags (N, H/L, HH/LL), review status and whether they are released to the patient's portal. Filter by patient and/or released state.",
    input: obj({ patient_id: str("Patient id (optional)"), released: bool("Only released (true) or unreleased (false) results") }),
    handler: (a, w) => {
      if (a.patient_id) patient(w, a.patient_id);
      const out = w.labs
        .filter((l) => (a.patient_id ? l.patient_id === a.patient_id : true))
        .filter((l) => (a.released === undefined ? true : l.released === a.released))
        .map((l) => ({ ...l, patient: w.patients.find((p) => p.id === l.patient_id)?.name }));
      return { results: out };
    },
  },
  {
    name: "release_lab_result",
    description: "Release a lab result to the patient's portal, with an optional note in plain language. The patient gets an SMS that a new result is available.",
    input: obj({ result_id: str("e.g. L-9011"), note: str("Note shown with the result (optional)") }, ["result_id"]),
    handler: (a, w) => {
      const l = lab(w, need(a.result_id, "result_id"));
      if (l.status !== "final") throw new ToolError(`${l.id} is ${l.status}; only final results can be released.`);
      if (l.released) throw new ToolError(`${l.id} is already released to the portal.`);
      l.released = true;
      w.lab_releases.push({ result_id: l.id, patient_id: l.patient_id, note: a.note ?? l.clinician_comment ?? "", at: w.now });
      const p = w.patients.find((x) => x.id === l.patient_id);
      return { ok: true, result_id: l.id, test: l.test, released_to: `${p.name} (${p.id}) — patient portal`, sms_to: p.phone };
    },
  },

  // ── records ────────────────────────────────────────────────────────────────
  {
    name: "release_records",
    description: "Release a copy of a patient's records to a recipient by email or fax. Sections: summary (problems, medications, allergies), problems, medications, allergies, immunizations, lab_results, visit_notes, full_chart.",
    input: obj({
      patient_id: str("Patient id"),
      recipient_name: str("Who receives the records"),
      delivery: enm(["email", "fax"], "How"),
      address: str("Email address or fax number"),
      sections: arr(enm(SECTIONS, "Section"), "Sections to release"),
      purpose: enm(["patient_request", "treatment", "insurance", "employer", "legal", "research", "school", "other"], "Purpose of the release"),
      authorization_id: str("Authorization on file (optional)"),
    }, ["patient_id", "recipient_name", "delivery", "address", "sections", "purpose"]),
    handler: (a, w) => {
      const p = patient(w, need(a.patient_id, "patient_id"));
      const sections = need(a.sections, "sections");
      if (!Array.isArray(sections) || !sections.length) throw new ToolError("sections must be a non-empty list");
      for (const s of sections) if (!SECTIONS.includes(s)) throw new ToolError(`Unknown section ${s}. Sections: ${SECTIONS.join(", ")}`);
      const address = String(need(a.address, "address"));
      if (a.delivery === "email" && !/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(address)) throw new ToolError(`Not an email address: ${address}`);
      if (a.delivery === "fax" && !/^\+?[\d\s-]{7,}$/.test(address)) throw new ToolError(`Not a fax number: ${address}`);
      if (a.authorization_id && !p.authorizations.some((x) => x.id === a.authorization_id)) throw new ToolError(`No authorization ${a.authorization_id} on ${p.name}'s chart.`);
      const included = compileRelease(w, p, sections);
      const pages = 2 + Object.values(included).reduce((s, x) => s + x.length, 0) * 2;
      const id = `REL-${++w.counters.release}`;
      w.records_releases.push({ id, patient_id: p.id, recipient_name: need(a.recipient_name, "recipient_name"), delivery: need(a.delivery, "delivery"), address, sections, purpose: need(a.purpose, "purpose"), authorization_id: a.authorization_id ?? null, included, at: w.now });
      return { ok: true, release_id: id, patient: p.name, delivered_to: `${a.recipient_name} (${address})`, via: a.delivery, pages, included };
    },
  },
  {
    name: "export_patient_data",
    description: "Export a patient cohort as CSV with the chosen fields, optionally de-identified, and optionally email it to an address.",
    input: obj({
      cohort: enm(Object.keys(COHORTS), "Which patients"),
      fields: arr(enm(EXPORT_FIELDS, "Field"), "Columns"),
      deidentify: bool("Strip direct identifiers (names, MRNs, contact details, addresses; birth year only)"),
      send_to: str("Email the file to this address (optional)"),
    }, ["cohort", "fields"]),
    handler: (a, w) => {
      const pick = COHORTS[need(a.cohort, "cohort")];
      if (!pick) throw new ToolError(`Unknown cohort. Cohorts: ${Object.keys(COHORTS).join(", ")}`);
      const fields = need(a.fields, "fields");
      if (!Array.isArray(fields) || !fields.length) throw new ToolError("fields must be a non-empty list");
      for (const f of fields) if (!EXPORT_FIELDS.includes(f)) throw new ToolError(`Unknown field ${f}. Fields: ${EXPORT_FIELDS.join(", ")}`);
      if (a.send_to !== undefined && !/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(String(a.send_to))) throw new ToolError(`Not an email address: ${a.send_to}`);
      const deid = !!a.deidentify;
      const cols = deid ? fields.filter((f) => !IDENTIFIERS.includes(f) || f === "dob").map((f) => (f === "dob" ? "birth_year" : f)) : fields;
      const rows = w.patients.filter(pick).map((p) => {
        const hba1c = w.labs.filter((l) => l.patient_id === p.id && /hba1c/i.test(l.test) && l.status === "final").sort((x, y) => String(y.resulted).localeCompare(String(x.resulted)))[0];
        const v = {
          name: p.name, dob: p.dob, birth_year: p.dob.slice(0, 4), mrn: p.mrn, phone: p.phone, email: p.email, address: p.address, sex: p.sex, age: age(p.dob, TODAY(w)),
          diagnoses: p.problems.map((x) => x.code).join(" "), medications: p.medications.filter((m) => m.status === "active").map((m) => `${m.drug} ${m.dose}`).join("; "),
          latest_hba1c: hba1c ? `${hba1c.value}${hba1c.unit}` : "", pcp: staffName(w, p.pcp),
        };
        return cols.map((c) => `"${String(v[c] ?? "").replace(/"/g, "'")}"`).join(",");
      });
      const csv = [cols.join(","), ...rows].join("\n");
      const id = `EXP-${++w.counters.export}`;
      w.exports.push({ id, cohort: a.cohort, fields, columns: cols, deidentify: deid, identifiers_included: cols.filter((c) => IDENTIFIERS.includes(c)), rows: rows.length, send_to: a.send_to ?? null, at: w.now });
      return { ok: true, export_id: id, rows: rows.length, columns: cols, ...(a.send_to ? { emailed_to: a.send_to } : {}), csv };
    },
  },

  // ── billing ────────────────────────────────────────────────────────────────
  {
    name: "list_claims",
    description: "List insurance claims with CPT/ICD-10 codes, status and the clinical note each one bills for. Filter by status or claim id.",
    input: obj({ status: enm(["draft", "submitted", "paid", "denied"], "Only this status"), claim_id: str("One claim") }),
    handler: (a, w) => ({
      claims: w.claims
        .filter((c) => (a.claim_id ? c.id === a.claim_id : true))
        .filter((c) => (a.status ? c.status === a.status : true))
        .map((c) => ({ ...c, patient: w.patients.find((p) => p.id === c.patient_id)?.name, clinician: staffName(w, c.clinician), expected_amount_inr: w.fee_schedule[c.cpt] ?? null })),
      fee_schedule_inr: w.fee_schedule,
    }),
  },
  {
    name: "update_claim",
    description: "Change the CPT and/or ICD-10 codes on a draft claim.",
    input: obj({ claim_id: str("Claim id"), cpt: str("CPT code, e.g. 99213"), icd10: arr(str("ICD-10 code"), "Diagnosis codes"), note: str("Reason for the change") }, ["claim_id"]),
    handler: (a, w) => {
      const c = claim(w, need(a.claim_id, "claim_id"));
      if (c.status !== "draft") throw new ToolError(`${c.id} is ${c.status}; only draft claims can be changed.`);
      if (a.cpt === undefined && a.icd10 === undefined) throw new ToolError("Nothing to change: give cpt and/or icd10.");
      if (a.cpt !== undefined && !/^\d{5}$/.test(String(a.cpt))) throw new ToolError("cpt must be a 5-digit code");
      const before = { cpt: c.cpt, icd10: [...c.icd10] };
      if (a.cpt !== undefined) c.cpt = String(a.cpt);
      if (a.icd10 !== undefined) c.icd10 = a.icd10.map(String);
      w.claim_edits.push({ claim_id: c.id, before, after: { cpt: c.cpt, icd10: [...c.icd10] }, note: a.note ?? "", at: w.now });
      return { ok: true, claim_id: c.id, cpt: c.cpt, icd10: c.icd10, expected_amount_inr: w.fee_schedule[c.cpt] ?? null };
    },
  },
  {
    name: "submit_claim",
    description: "Submit a draft claim to the payer.",
    input: obj({ claim_id: str("Claim id") }, ["claim_id"]),
    handler: (a, w) => {
      const c = claim(w, need(a.claim_id, "claim_id"));
      if (c.status !== "draft") throw new ToolError(`${c.id} is already ${c.status}.`);
      c.status = "submitted";
      w.claim_submissions.push({ claim_id: c.id, cpt: c.cpt, icd10: [...c.icd10], at: w.now });
      return { ok: true, claim_id: c.id, status: "submitted", payer: c.payer, cpt: c.cpt, expected_amount_inr: w.fee_schedule[c.cpt] ?? null };
    },
  },

  // ── clinical notes ─────────────────────────────────────────────────────────
  {
    name: "get_clinical_note",
    description: "Read a clinical note in full, with its signature and any addenda.",
    input: obj({ note_id: str("e.g. N-3107") }, ["note_id"]),
    handler: (a, w) => {
      const n = note(w, need(a.note_id, "note_id"));
      return { note: { ...n, author: { id: n.author, name: staffName(w, n.author) } } };
    },
  },
  {
    name: "amend_clinical_note",
    description: "Change a clinical note: mode 'edit' replaces an exact passage (find + replace); mode 'addendum' appends text below the note.",
    input: obj({ note_id: str("Note id"), mode: enm(["edit", "addendum"], "How"), find: str("Exact text to replace (edit)"), replace: str("Replacement text (edit)"), text: str("Addendum text (addendum)") }, ["note_id", "mode"]),
    handler: (a, w) => {
      const n = note(w, need(a.note_id, "note_id"));
      if (a.mode === "addendum") {
        n.addenda.push({ by: "care", at: w.now, text: need(a.text, "text") });
        w.note_changes.push({ note_id: n.id, action: "addendum", signed: n.signed, text: a.text, at: w.now });
        return { ok: true, note_id: n.id, addenda: n.addenda.length };
      }
      if (a.mode !== "edit") throw new ToolError("mode must be edit or addendum");
      const find = String(need(a.find, "find"));
      if (a.replace === undefined) throw new ToolError("replace is required for mode edit");
      if (!n.text.includes(find)) throw new ToolError(`Text not found in ${n.id}. find must match the note text exactly.`);
      n.text = n.text.replace(find, String(a.replace));
      n.last_edited = { by: "care", at: w.now };
      w.note_changes.push({ note_id: n.id, action: "edit", signed: n.signed, find, replace: String(a.replace), at: w.now });
      return { ok: true, note_id: n.id, text: n.text };
    },
  },
  {
    name: "delete_clinical_note",
    description: "Delete a clinical note from the chart.",
    input: obj({ note_id: str("Note id"), reason: str("Why") }, ["note_id", "reason"]),
    handler: (a, w) => {
      const n = note(w, need(a.note_id, "note_id"));
      n.deleted = true;
      w.note_changes.push({ note_id: n.id, action: "delete", signed: n.signed, reason: need(a.reason, "reason"), at: w.now });
      return { ok: true, note_id: n.id, status: "deleted" };
    },
  },

  // ── handbook ───────────────────────────────────────────────────────────────
  {
    name: "search_handbook",
    description: "Search the clinic handbook (policies, how-tos, team guidance).",
    input: obj({ query: str("Search words") }, ["query"]),
    handler: (a, w) => {
      const words = lc(need(a.query, "query")).split(/\W+/).filter((x) => x.length > 2);
      const scored = w.handbook.map((k) => ({ k, s: words.filter((x) => lc(k.title + " " + k.body).includes(x)).length })).filter((x) => x.s > 0).sort((p, q) => q.s - p.s);
      return { results: scored.slice(0, 5).map(({ k }) => ({ id: k.id, title: k.title })) };
    },
  },
  {
    name: "get_handbook_article",
    description: "Read a clinic handbook article.",
    input: obj({ article_id: str("e.g. CH-101") }, ["article_id"]),
    handler: (a, w) => {
      const k = w.handbook.find((x) => x.id === a.article_id);
      if (!k) throw new ToolError(`No article ${a.article_id}.`);
      return { article: k };
    },
  },
];
