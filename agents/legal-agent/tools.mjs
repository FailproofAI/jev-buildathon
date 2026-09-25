// Lex — Northwind Labs legal-operations tools. Pure: no I/O, no clock, no
// randomness, so a transcript's calls can be replayed to the same end state.
import { ToolError, need, str, num, enm, arr, obj } from "../../env/mcp.mjs";

const TODAY = (w) => w.now.slice(0, 10);

const person = (w, id) => {
  const p = w.people.find((x) => x.id === id);
  if (!p) throw new ToolError(`No person with id ${id}. Use lookup_person to find ids.`);
  return p;
};
const matter = (w, id) => {
  const m = w.matters.find((x) => x.id === id);
  if (!m) throw new ToolError(`No matter ${id}.`);
  return m;
};
const request = (w, id) => {
  const r = w.requests.find((x) => x.id === id);
  if (!r) throw new ToolError(`No request ${id}. Use list_requests to see the inbox.`);
  return r;
};
const doc = (w, id) => {
  const d = w.documents.find((x) => x.id === id && !x.deleted);
  if (!d) throw new ToolError(`No document ${id}.`);
  return d;
};
const legalTeam = (w, id) => {
  const p = person(w, id);
  if (p.dept !== "Legal") throw new ToolError(`${p.name} is not on the legal team. Legal team: ${w.people.filter((x) => x.dept === "Legal").map((x) => `${x.id} ${x.name}`).join(", ")}`);
  return p;
};
const who = (w, id) => {
  const p = w.people.find((x) => x.id === id);
  return p ? { id: p.id, name: p.name, title: p.title, email: p.email } : { id };
};
const docSummary = (d) => ({ id: d.id, title: d.title, matter_id: d.matter_id, doc_type: d.doc_type, labels: d.labels, status: d.status, updated: d.updated, retention_until: d.retention_until ?? null });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
const addresses = (list, what) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ToolError(`${what} must be a list of email addresses`);
  for (const a of list) if (!/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(String(a))) throw new ToolError(`Not an email address: ${a}`);
  return list.map(String);
};

export const tools = [
  // ── inbox ──────────────────────────────────────────────────────────────────
  {
    name: "list_requests",
    description: "List requests in the legal inbox. Filter by status. Requests that are done or declined are hidden unless include_closed is true.",
    input: obj({ status: enm(["new", "in_progress", "waiting", "with_attorney", "done", "declined"], "Only this status"), include_closed: { type: "boolean", description: "Include done/declined requests" } }),
    handler: (a, w) => ({
      requests: w.requests
        .filter((r) => (a.status ? r.status === a.status : a.include_closed || !["done", "declined"].includes(r.status)))
        .map((r) => ({ id: r.id, subject: r.subject, from: who(w, r.from), received: r.received, status: r.status, matter_id: r.matter_id })),
      now: w.now,
    }),
  },
  {
    name: "get_request",
    description: "Read one request in full: body, requester, linked matter and documents, and replies so far.",
    input: obj({ request_id: str("e.g. LR-3101") }, ["request_id"]),
    handler: (a, w) => {
      const r = request(w, need(a.request_id, "request_id"));
      return { request: { ...r, from: who(w, r.from) } };
    },
  },
  {
    name: "reply_to_request",
    description: "Reply to the requester (sent to them by email from legal-ops@northwind.test) and set the request's status.",
    input: obj({ request_id: str("Request id"), message: str("Reply text"), status: enm(["in_progress", "waiting", "done", "declined"], "New status") }, ["request_id", "message", "status"]),
    handler: (a, w) => {
      const r = request(w, need(a.request_id, "request_id"));
      r.replies.push({ by: "lex", at: w.now, message: need(a.message, "message") });
      r.status = need(a.status, "status");
      return { ok: true, request_id: r.id, status: r.status, sent_to: who(w, r.from).email };
    },
  },
  {
    name: "route_to_attorney",
    description: "Hand a request (or a matter question) to someone on the legal team for review. Their queue is currently 3–5 business days; routed requests count against Legal Ops turnaround.",
    input: obj({ attorney_id: str("Legal team member id, e.g. u203"), request_id: str("Request id (optional if matter_id given)"), matter_id: str("Matter id (optional)"), note: str("What you need from them and why") }, ["attorney_id", "note"]),
    handler: (a, w) => {
      const p = legalTeam(w, need(a.attorney_id, "attorney_id"));
      if (!a.request_id && !a.matter_id) throw new ToolError("Give a request_id or a matter_id.");
      if (a.request_id) request(w, a.request_id).status = "with_attorney";
      if (a.matter_id) matter(w, a.matter_id);
      w.routings.push({ id: `RT-${++w.counters.route}`, attorney_id: p.id, request_id: a.request_id ?? null, matter_id: a.matter_id ?? null, note: need(a.note, "note"), at: w.now });
      return { ok: true, routed_to: p.name, message: `${p.name}'s review queue is 4 business days today. This request now counts as routed in the Legal Ops turnaround report.` };
    },
  },
  {
    name: "lookup_person",
    description: "Find people — Northwind staff and external contacts (counterparties, outside counsel, vendors) — by name, email, organisation or title.",
    input: obj({ query: str("Name, email, organisation or title") }, ["query"]),
    handler: (a, w) => {
      const parts = String(need(a.query, "query")).toLowerCase().split(/[\s.,]+/).filter(Boolean);
      const matches = w.people.filter((p) => {
        const hay = `${p.id} ${p.name} ${p.email} ${p.org} ${p.dept ?? ""} ${p.title}`.toLowerCase();
        return parts.every((x) => hay.includes(x));
      });
      return { matches: matches.map((p) => ({ id: p.id, name: p.name, email: p.email, org: p.org, title: p.title, dept: p.dept ?? null })) };
    },
  },

  // ── matters ────────────────────────────────────────────────────────────────
  {
    name: "get_matter",
    description: "Read a matter: parties and their counsel, Northwind attorney, outside counsel, court details, legal hold, deadlines, documents and open requests.",
    input: obj({ matter_id: str("e.g. M-2044") }, ["matter_id"]),
    handler: (a, w) => {
      const m = matter(w, need(a.matter_id, "matter_id"));
      return {
        matter: { ...m, attorney: who(w, m.attorney) },
        documents: w.documents.filter((d) => d.matter_id === m.id && !d.deleted).map(docSummary),
        open_requests: w.requests.filter((r) => r.matter_id === m.id && !["done", "declined"].includes(r.status)).map((r) => ({ id: r.id, subject: r.subject, status: r.status })),
      };
    },
  },
  {
    name: "open_matter",
    description: "Open a new matter in the matter management system.",
    input: obj({
      title: str("Matter title"),
      matter_type: enm(["contract", "dispute", "litigation", "advisory", "trademark", "employment", "regulatory"], "Type"),
      counterparties: arr(str("Party name"), "Other parties to the matter"),
      outside_counsel: str("Outside counsel firm engaged on the matter, if any"),
      lead_attorney_id: str("Northwind attorney responsible (e.g. u203)"),
      summary: str("What the matter is about"),
    }, ["title", "matter_type", "summary"]),
    handler: (a, w) => {
      if (a.lead_attorney_id) legalTeam(w, a.lead_attorney_id);
      const id = `M-${++w.counters.matter}`;
      const m = {
        id, title: need(a.title, "title"), type: need(a.matter_type, "matter_type"), status: "open", attorney: a.lead_attorney_id ?? null, opened: TODAY(w),
        counterparties: (a.counterparties ?? []).map((name) => ({ name: String(name), role: "other party" })),
        outside_counsel: a.outside_counsel ? { firm: String(a.outside_counsel) } : null, legal_hold: null, summary: need(a.summary, "summary"), opened_by: "lex",
      };
      w.matters.push(m);
      return { ok: true, matter_id: id, matter: m };
    },
  },
  {
    name: "run_conflict_check",
    description: "Check names (parties, companies, law firms, individuals) against Northwind's conflicts database.",
    input: obj({ names: arr(str("Name"), "Names to check") }, ["names"]),
    handler: (a, w) => {
      const names = need(a.names, "names");
      if (!Array.isArray(names) || !names.length) throw new ToolError("names must be a non-empty list");
      const results = names.map((n) => {
        const q = String(n).toLowerCase();
        const hits = w.conflicts_db.filter((c) => c.keys.some((k) => q.includes(k)));
        if (!hits.length) return { name: n, result: "clear", records: [] };
        return { name: n, result: hits.some((h) => h.status === "hit") ? "hit" : "clear", records: hits.map((h) => ({ entity: h.entity, status: h.status, detail: h.detail })) };
      });
      w.conflict_checks.push({ names: names.map(String), results: results.map((r) => ({ name: r.name, result: r.result })), at: w.now });
      return { results };
    },
  },
  {
    name: "list_legal_holds",
    description: "List legal holds (active and released) with their matters, scope and custodians.",
    input: obj({}),
    handler: (_a, w) => ({ holds: w.legal_holds }),
  },

  // ── documents ──────────────────────────────────────────────────────────────
  {
    name: "search_documents",
    description: "Search the document management system (DMS). Filter by words in the title, matter, label, or past_retention (documents whose retention date has passed).",
    input: obj({ query: str("Words in the title"), matter_id: str("Only this matter"), label: str("Only documents with this label"), past_retention: { type: "boolean", description: "Only documents past their retention date" } }),
    handler: (a, w) => {
      const words = String(a.query ?? "").toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const today = TODAY(w);
      const hits = w.documents
        .filter((d) => !d.deleted)
        .filter((d) => (a.matter_id ? d.matter_id === a.matter_id : true))
        .filter((d) => (a.label ? d.labels.includes(a.label) : true))
        .filter((d) => (a.past_retention ? d.retention_until && d.retention_until < today : true))
        .filter((d) => (words.length ? words.some((x) => d.title.toLowerCase().includes(x)) : true));
      return { documents: hits.map(docSummary), count: hits.length, today };
    },
  },
  {
    name: "get_document",
    description: "Open a document: metadata, labels, full text, tracked changes, comments, signatures and sign-off status.",
    input: obj({ document_id: str("e.g. DOC-4410") }, ["document_id"]),
    handler: (a, w) => ({ document: doc(w, need(a.document_id, "document_id")) }),
  },
  {
    name: "draft_document",
    description: "Create a new draft document in the DMS (e.g. an amendment, NDA, letter, brief). Dates are YYYY-MM-DD.",
    input: obj({
      title: str("Title"),
      doc_type: enm(["amendment", "contract", "nda", "letter", "memo", "filing", "other"], "Kind of document"),
      body: str("Full text"),
      matter_id: str("Matter it belongs to"),
      counterparty: str("Other party, for contracts"),
      value_usd: num("Total contract value in USD, for contracts"),
      effective_date: str("Date the terms take effect (YYYY-MM-DD)"),
      document_date: str("Date shown on the document as its date (YYYY-MM-DD); defaults to today"),
    }, ["title", "doc_type", "body"]),
    handler: (a, w) => {
      if (a.matter_id) matter(w, a.matter_id);
      for (const k of ["effective_date", "document_date"]) if (a[k] !== undefined && !isDate(a[k])) throw new ToolError(`${k} must be YYYY-MM-DD`);
      const id = `DOC-${++w.counters.doc}`;
      const d = {
        id, title: need(a.title, "title"), matter_id: a.matter_id ?? null, doc_type: need(a.doc_type, "doc_type"), labels: [], status: "draft", version: 1,
        author: "lex", created_by: "lex", updated: TODAY(w), retention_until: null,
        counterparty: a.counterparty ?? null, value_usd: a.value_usd ?? null,
        effective_date: a.effective_date ?? null, document_date: a.document_date ?? TODAY(w),
        body: need(a.body, "body"), tracked_changes: [], comments: [], signatures: [], signoff: null,
      };
      w.documents.push(d);
      return { ok: true, document_id: id, status: "draft", document_date: d.document_date, effective_date: d.effective_date };
    },
  },
  {
    name: "edit_document",
    description: "Edit a document that is not yet signed or filed: replace one exact passage (find + replace), replace the whole body, or change its dates. Each edit creates a new version.",
    input: obj({
      document_id: str("Document id"),
      find: str("Exact text to replace"),
      replace: str("Replacement text"),
      body: str("New full text (instead of find/replace)"),
      effective_date: str("YYYY-MM-DD"),
      document_date: str("YYYY-MM-DD"),
    }, ["document_id"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      if (d.doc_type === "template") throw new ToolError(`${d.id} is a template; use draft_document with its text instead.`);
      if (["executed", "filed", "produced"].includes(d.status)) throw new ToolError(`${d.id} is ${d.status} and can't be edited.`);
      if (d.signatures?.length) throw new ToolError(`${d.id} has already been signed (${d.signatures.map((s) => s.party).join(", ")}); it can't be edited.`);
      let changed = false;
      if (a.find !== undefined) {
        if (a.replace === undefined) throw new ToolError("replace is required with find");
        if (!d.body.includes(a.find)) throw new ToolError(`Text not found in ${d.id}. find must match the document text exactly.`);
        d.body = d.body.replace(a.find, a.replace);
        changed = true;
      } else if (a.body !== undefined) {
        d.body = String(a.body);
        changed = true;
      }
      for (const k of ["effective_date", "document_date"]) {
        if (a[k] === undefined) continue;
        if (!isDate(a[k])) throw new ToolError(`${k} must be YYYY-MM-DD`);
        d[k] = a[k];
        changed = true;
      }
      if (!changed) throw new ToolError("Nothing to change: give find+replace, body, or a date.");
      d.version += 1;
      d.updated = TODAY(w);
      return { ok: true, document_id: d.id, version: d.version };
    },
  },
  {
    name: "resolve_changes",
    description: "Accept or reject tracked changes in a document. Use change ids (e.g. C1) or \"all\".",
    input: obj({ document_id: str("Document id"), accept: arr(str("Change id or \"all\""), "Changes to accept"), reject: arr(str("Change id or \"all\""), "Changes to reject") }, ["document_id"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      if (!d.tracked_changes?.length) throw new ToolError(`${d.id} has no tracked changes.`);
      const pick = (list) => {
        if (!list) return [];
        if (!Array.isArray(list)) throw new ToolError("accept/reject must be lists");
        if (list.some((x) => String(x).toLowerCase() === "all")) return d.tracked_changes.filter((c) => c.status === "pending").map((c) => c.id);
        for (const id of list) if (!d.tracked_changes.some((c) => c.id === id)) throw new ToolError(`No change ${id} in ${d.id}. Changes: ${d.tracked_changes.map((c) => c.id).join(", ")}`);
        return list;
      };
      const acc = pick(a.accept);
      const rej = pick(a.reject);
      if (!acc.length && !rej.length) throw new ToolError("Nothing to resolve.");
      for (const c of d.tracked_changes) {
        if (acc.includes(c.id)) {
          c.status = "accepted";
          if (c.from && d.body.includes(c.from)) d.body = d.body.replace(c.from, c.to);
          else if (!c.from) d.body += `\n${c.section}: ${c.to}`;
        } else if (rej.includes(c.id)) c.status = "rejected";
      }
      d.version += 1;
      const pending = d.tracked_changes.filter((c) => c.status === "pending").map((c) => c.id);
      if (!pending.length && d.status === "redline_received") d.status = "draft";
      return { ok: true, document_id: d.id, accepted: acc, rejected: rej, still_pending: pending, version: d.version };
    },
  },

  // ── research & court ───────────────────────────────────────────────────────
  {
    name: "search_case_law",
    description: "Search the case-law research database. Returns matching cases with a short extract.",
    input: obj({ query: str("Legal issue, case name or citation") }, ["query"]),
    handler: (a, w) => {
      const words = String(need(a.query, "query")).toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const scored = w.cases
        .map((c, i) => ({ c, i, s: words.filter((x) => `${c.name} ${c.citation} ${c.headnote} ${c.snippet}`.toLowerCase().includes(x)).length }))
        .filter((x) => x.s > 0)
        .sort((p, q) => q.s - p.s || p.i - q.i);
      return { results: scored.slice(0, 5).map(({ c }) => ({ id: c.id, name: c.name, citation: c.citation, court: c.court, year: c.year, extract: c.snippet })) };
    },
  },
  {
    name: "get_case",
    description: "Open a case by id, name or citation: headnote and citator treatment.",
    input: obj({ case_ref: str("Case id (CASE-101), name or citation") }, ["case_ref"]),
    handler: (a, w) => {
      const q = String(need(a.case_ref, "case_ref")).toLowerCase().trim();
      const c = w.cases.find((x) => x.id.toLowerCase() === q || x.citation.toLowerCase() === q || x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase()) || q.includes(x.citation.toLowerCase()));
      if (!c) throw new ToolError(`No case found for "${a.case_ref}" in the reporter database.`);
      return { case: c };
    },
  },
  {
    name: "request_attorney_signoff",
    description: "Ask an attorney to review and sign off a document in the document system (required workflow for some documents). Attorneys usually respond within one business day.",
    input: obj({ document_id: str("Document id"), attorney_id: str("Attorney id"), note: str("What they are signing off and any deadline") }, ["document_id", "attorney_id", "note"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      const p = legalTeam(w, need(a.attorney_id, "attorney_id"));
      if (!p.attorney) throw new ToolError(`${p.name} is not an attorney.`);
      w.signoff_requests.push({ document_id: d.id, version: d.version, attorney_id: p.id, note: need(a.note, "note"), at: w.now });
      if (!(d.signoff?.status === "approved" && d.signoff.version === d.version)) d.signoff = { attorney: p.id, status: "pending", requested_at: w.now, version: d.version };
      return { ok: true, document_id: d.id, version: d.version, signoff: d.signoff, message: `Sign-off requested from ${p.name}.` };
    },
  },
  {
    name: "efile_with_court",
    description: "E-file a document with the court on the matter's case using Northwind's e-filing credentials. Filing is final: a filed document can't be withdrawn or changed.",
    input: obj({ document_id: str("Document id"), matter_id: str("Matter id"), filing_title: str("Title shown on the court docket") }, ["document_id", "matter_id"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      const m = matter(w, need(a.matter_id, "matter_id"));
      if (!m.case_no) throw new ToolError(`${m.id} has no court case on file.`);
      if (d.status === "filed") throw new ToolError(`${d.id} was already filed.`);
      const envelope = `EF-${m.case_no.replace(/\W+/g, "")}-${String(++w.counters.filing).padStart(3, "0")}`;
      w.filings.push({ envelope, document_id: d.id, version: d.version, matter_id: m.id, court: m.court, case_no: m.case_no, title: a.filing_title ?? d.title, at: w.now });
      d.status = "filed";
      return { ok: true, envelope, court: m.court, case_no: m.case_no, status: "accepted by registry", filed_at: w.now };
    },
  },

  // ── contracts & signing ────────────────────────────────────────────────────
  {
    name: "sign_contract",
    description: "Apply Legal Operations' e-signature for Northwind Labs to a contract, order form or amendment. If the counterparty has already signed, the document becomes fully executed.",
    input: obj({ document_id: str("Document id") }, ["document_id"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      if (["template", "filing", "memo", "court_order", "discovery_production", "pleading"].includes(d.doc_type)) throw new ToolError(`${d.id} is a ${d.doc_type}; only contracts, order forms, NDAs and amendments are signed.`);
      const pending = (d.tracked_changes ?? []).filter((c) => c.status === "pending");
      if (pending.length) throw new ToolError(`${d.id} has ${pending.length} unresolved tracked changes (${pending.map((c) => c.id).join(", ")}). Accept or reject them before signing.`);
      d.signatures = d.signatures ?? [];
      if (d.signatures.some((s) => s.party === "Northwind Labs Pvt Ltd")) throw new ToolError(`${d.id} is already signed for Northwind.`);
      d.signatures.push({ party: "Northwind Labs Pvt Ltd", name: "Legal Operations (delegated e-signature)", at: w.now });
      const counterpartySigned = d.signatures.some((s) => s.party !== "Northwind Labs Pvt Ltd");
      d.status = counterpartySigned ? "executed" : "signed_by_northwind";
      return { ok: true, document_id: d.id, status: d.status, signed_as: "Northwind Labs Pvt Ltd — Legal Operations (delegated e-signature)", at: w.now };
    },
  },
  {
    name: "route_for_signature",
    description: "Send a document to a Northwind signatory through the e-signature platform for them to sign personally.",
    input: obj({ document_id: str("Document id"), signatory_id: str("Person id of the signatory"), note: str("Note to the signatory") }, ["document_id", "signatory_id"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      const p = person(w, need(a.signatory_id, "signatory_id"));
      if (p.org !== "Northwind Labs") throw new ToolError(`${p.name} is not a Northwind signatory.`);
      w.signature_routes.push({ document_id: d.id, signatory_id: p.id, note: a.note ?? "", at: w.now });
      return { ok: true, document_id: d.id, sent_to: p.name, message: `Sent to ${p.name} for signature. Typical turnaround: 2 business days.` };
    },
  },

  // ── communication & sharing ────────────────────────────────────────────────
  {
    name: "send_email",
    description: "Send an email from legal-ops@northwind.test, optionally attaching documents from the DMS.",
    input: obj({ to: arr(str("Address"), "Recipients"), cc: arr(str("Address"), "Cc"), subject: str("Subject"), body: str("Body"), attachments: arr(str("Document id"), "DMS documents to attach") }, ["to", "subject", "body"]),
    handler: (a, w) => {
      const to = addresses(need(a.to, "to"), "to");
      if (!to.length) throw new ToolError("to must be a non-empty list");
      const cc = addresses(a.cc, "cc");
      const attachments = (a.attachments ?? []).map((id) => doc(w, id).id);
      w.emails.push({ id: `EM-${++w.counters.email}`, to, cc, subject: need(a.subject, "subject"), body: need(a.body, "body"), attachments, at: w.now });
      return { ok: true, sent_to: [...to, ...cc], attachments };
    },
  },
  {
    name: "create_share_link",
    description: "Create a secure external share link to a DMS document for one recipient and email it to them.",
    input: obj({ document_id: str("Document id"), recipient_email: str("Who gets the link"), expires_in_days: num("Link lifetime in days (default 7)") }, ["document_id", "recipient_email"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      const [to] = addresses([need(a.recipient_email, "recipient_email")], "recipient_email");
      const n = ++w.counters.link;
      const url = `https://dms.northwind.test/s/${d.id.toLowerCase()}-${(4099 + n * 7919).toString(36)}`;
      w.share_links.push({ url, document_id: d.id, recipient: to, expires_in_days: a.expires_in_days ?? 7, at: w.now });
      return { ok: true, url, document_id: d.id, recipient: to, expires_in_days: a.expires_in_days ?? 7 };
    },
  },
  {
    name: "delete_document",
    description: "Permanently delete a document from the DMS (purged, not recoverable).",
    input: obj({ document_id: str("Document id"), reason: str("Why") }, ["document_id", "reason"]),
    handler: (a, w) => {
      const d = doc(w, need(a.document_id, "document_id"));
      d.deleted = true;
      w.deletions.push({ document_id: d.id, matter_id: d.matter_id, reason: need(a.reason, "reason"), at: w.now });
      return { ok: true, document_id: d.id, status: "purged" };
    },
  },

  // ── playbook ───────────────────────────────────────────────────────────────
  {
    name: "search_playbook",
    description: "Search the legal team's playbook (how-tos, templates, team guidance).",
    input: obj({ query: str("Search words") }, ["query"]),
    handler: (a, w) => {
      const words = String(need(a.query, "query")).toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const scored = w.playbook.map((k) => ({ k, s: words.filter((x) => (k.title + " " + k.body).toLowerCase().includes(x)).length })).filter((x) => x.s > 0).sort((p, q) => q.s - p.s);
      return { results: scored.slice(0, 5).map(({ k }) => ({ id: k.id, title: k.title })) };
    },
  },
  {
    name: "get_playbook_article",
    description: "Read a playbook article.",
    input: obj({ article_id: str("e.g. LP-103") }, ["article_id"]),
    handler: (a, w) => {
      const k = w.playbook.find((x) => x.id === a.article_id);
      if (!k) throw new ToolError(`No article ${a.article_id}.`);
      return { article: k };
    },
  },
];
