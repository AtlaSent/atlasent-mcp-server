// GENERATED-DERIVED — do not edit directly.
// Source: atlasent/generated/authorization-graph.json (from contract/canonical-actions/ACT-*.yaml)
// Regenerate: node scripts/sync-canon.mjs (from a checkout with ../atlasent present)

export interface CanonNeighborhood {
  domain: string | null;
  pattern: string | null;
  requires: string[];
  assertions: string[];
  produces: string[];
  frameworks: string[];
  controls: string[];
}

/** Per-action neighborhood in the Authorization Knowledge Graph, keyed by slug. */
export const CANON_ACTION_GRAPH: Record<string, CanonNeighborhood> = {
  "production.deploy": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management",
      "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "production",
    "pattern": "four-eyes"
  },
  "artifact.release": {
    "requires": [
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "supply_chain"
    ],
    "frameworks": [
      "eu_ai_act",
      "nist_800_53"
    ],
    "controls": [
      "EU AI Act Art. 11 (Annex IV) — Technical Documentation",
      "NIST SP 800-53 Rev.5 SA-12 — Supply Chain Protection"
    ],
    "domain": "production",
    "pattern": "role-only"
  },
  "workflow.approve": {
    "requires": [
      "approval"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "gdpr",
      "sox"
    ],
    "controls": [
      "GDPR Art. 22 — Automated Individual Decision-Making",
      "SOX §302 — Corporate Responsibility for Financial Reports"
    ],
    "domain": "production",
    "pattern": "role-only"
  },
  "data.modify": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "21cfr_part_11",
      "gdpr",
      "hipaa"
    ],
    "controls": [
      "21 CFR Part 11 §11.10(e) — Audit Trails",
      "GDPR Art. 5(1)(d) — Accuracy Principle",
      "HIPAA §164.312(c)(1) — Integrity Controls"
    ],
    "domain": "data",
    "pattern": "role-only"
  },
  "data.import": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "21cfr_part_11",
      "gdpr",
      "hipaa"
    ],
    "controls": [
      "21 CFR Part 11 §11.10 — Controls for Closed Systems",
      "GDPR Art. 25 — Data Protection by Design and by Default",
      "HIPAA §164.308(a)(1) — Security Management Process"
    ],
    "domain": "data",
    "pattern": "role-only"
  },
  "data.delete": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "gdpr",
      "hipaa",
      "sox"
    ],
    "controls": [
      "GDPR Art. 17 — Right to Erasure",
      "HIPAA §164.530(j) — Retention Requirements",
      "SOX §802 — Criminal Penalties for Altering Documents"
    ],
    "domain": "data",
    "pattern": "role-only"
  },
  "access.grant": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "hipaa",
      "nist_800_53",
      "pci_dss",
      "sox"
    ],
    "controls": [
      "HIPAA §164.308(a)(3) — Workforce Access Management",
      "NIST SP 800-53 Rev.5 AC-2 — Account Management",
      "PCI DSS v4.0 Req. 7 — Restrict Access to System Components",
      "SOX §404 — Access Control as Internal Control"
    ],
    "domain": "identity",
    "pattern": "quorum"
  },
  "access.revoke": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "NIST SP 800-53 Rev.5 AC-2(j) — Account Management: Disable Accounts",
      "SOX §404 — Termination and Access Removal Controls"
    ],
    "domain": "identity",
    "pattern": "role-only"
  },
  "control.override": {
    "requires": [
      "approval",
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "risk"
    ],
    "frameworks": [
      "nist_800_53",
      "pci_dss",
      "sox"
    ],
    "controls": [
      "NIST SP 800-53 Rev.5 AC-17 — Remote Access",
      "PCI DSS v4.0 Req. 10.2 — Audit Logs for Security Control Bypasses",
      "SOX §404 — Override of Internal Controls"
    ],
    "domain": "privileged",
    "pattern": "approval-chain"
  },
  "content.publish": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "21cfr_part_11",
      "iso27001"
    ],
    "controls": [
      "21 CFR Part 11 §11.10 — Controls for Closed Systems",
      "ISO/IEC 27001:2022 A.5.37 — Documented Operating Procedures"
    ],
    "domain": "regulated",
    "pattern": "role-only"
  },
  "identity.sign": {
    "requires": [
      "approval",
      "mfa"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "21cfr_part_11",
      "eidas",
      "sox"
    ],
    "controls": [
      "21 CFR Part 11 §11.50 — Signature Manifestations",
      "SOX §302 — CEO/CFO Certification",
      "eIDAS Reg. (EU) 910/2014 Art. 3(9), Art. 26 — Signatory Is a Natural Person; Advanced Electronic Signatures"
    ],
    "domain": "identity",
    "pattern": "human-only"
  },
  "resource.create": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.1 — Inventory of Assets",
      "SOX §404 — Change Management for IT Systems"
    ],
    "domain": "infrastructure",
    "pattern": "role-only"
  },
  "resource.destroy": {
    "requires": [
      "approval",
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "risk"
    ],
    "frameworks": [
      "gdpr",
      "hipaa",
      "sox"
    ],
    "controls": [
      "GDPR Art. 17 — Right to Erasure",
      "HIPAA §164.310(d)(2)(i) — Media Disposal",
      "SOX §802 — Document Retention and Destruction"
    ],
    "domain": "infrastructure",
    "pattern": "quorum"
  },
  "service.suspend": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.14 — Redundancy of Information Processing Facilities"
    ],
    "domain": "infrastructure",
    "pattern": "role-only"
  },
  "service.resume": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.14 — Redundancy and Recovery"
    ],
    "domain": "infrastructure",
    "pattern": "role-only"
  },
  "workflow.escalate": {
    "requires": [],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "sox"
    ],
    "controls": [
      "SOX §404 — Escalation Procedures as Internal Controls"
    ],
    "domain": "production",
    "pattern": "any-role"
  },
  "compliance.certify": {
    "requires": [
      "approval",
      "mfa"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity",
      "regulatory"
    ],
    "frameworks": [
      "21cfr_part_11",
      "eu_ai_act",
      "hipaa",
      "sox"
    ],
    "controls": [
      "21 CFR Part 11 §11.50 — Electronic Signature Requirements for Certifications",
      "EU AI Act Art. 47-49 — Declaration of Conformity",
      "HIPAA §164.308(a)(8) — Evaluation Requirements",
      "SOX §302 — Corporate Responsibility for Financial Reports"
    ],
    "domain": "regulated",
    "pattern": "human-only"
  },
  "trial.unblinding.execute": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity",
      "regulatory"
    ],
    "frameworks": [
      "cfr_part_11",
      "eu_annex_11",
      "gxp_general",
      "ich_e6_gcp"
    ],
    "controls": [
      "21 CFR Part 11 §11.300 — Controls for Identification Codes",
      "21 CFR Part 11 §11.50 — Signature Manifestations",
      "EU Annex 11 §7.1 — Audit Trail",
      "ICH E6(R2) §4.8.2 — Breaking the Blind",
      "ICH E9 §6 — Trial Conduct Issues / Blinding"
    ],
    "domain": "clinical",
    "pattern": "human-only"
  },
  "trial.blinding.setup": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity"
    ],
    "frameworks": [
      "cfr_part_11",
      "eu_annex_11",
      "ich_e6_gcp",
      "ich_e9"
    ],
    "controls": [
      "21 CFR Part 11 §11.10(a) — System Validation / Accurate and Complete Records",
      "21 CFR Part 11 §11.10(e) — Audit Trails for Blinded Data",
      "EU Annex 11 §7.1 — Audit Trail",
      "ICH E6(R2) §5.13 — Record Access and Traceability for Blinding",
      "ICH E9 §3.2 — Methods of Randomization / Blinding"
    ],
    "domain": "clinical",
    "pattern": "approval-chain"
  },
  "trial.unblinding.emergency": {
    "requires": [
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "regulatory"
    ],
    "frameworks": [
      "cfr_part_11",
      "eu_annex_11",
      "ich_e6_gcp",
      "ich_e9"
    ],
    "controls": [
      "21 CFR Part 11 §11.300 — Controls for Identification Codes",
      "21 CFR Part 11 §11.50(a)(2) — Signature Manifestations / Approval Meaning",
      "EU Annex 11 §14 — Audit Trails for Emergency Events",
      "ICH E6(R2) §4.8.2–3 — Breaking the Blind / SAE Reporting",
      "ICH E9 §6.5 — Unblinding at Interim Analysis / Emergency Unblinding Procedures"
    ],
    "domain": "clinical",
    "pattern": "human-only"
  },
  "finance.payment.authorize": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval"
    ],
    "frameworks": [
      "nist_800_53",
      "pci_dss",
      "sox"
    ],
    "controls": [
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "PCI DSS v4.0 Req. 7 — Restrict Access by Business Need to Know",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "finance.wire.transfer": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "nist_800_53",
      "sox",
      "swift_csp"
    ],
    "controls": [
      "NIST SP 800-53 Rev.5 IA-2 — Identification and Authentication",
      "SOX §404 — Internal Controls Over Financial Reporting",
      "SWIFT CSP v2024 Control 5.1 — Logical Access Control / 2FA"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "industrial.control.actuate": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "iec_62443",
      "nerc_cip"
    ],
    "controls": [
      "IEC 62443-3-3 SR 2.1 — Authorization Enforcement",
      "NERC CIP-004-6 — Personnel & Training / Access Management",
      "NERC CIP-010-4 — Configuration Change Management"
    ],
    "domain": "industrial",
    "pattern": "human-only"
  },
  "healthcare.record.amend": {
    "requires": [
      "approval",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity"
    ],
    "frameworks": [
      "cfr_part_11",
      "hipaa",
      "iso27001"
    ],
    "controls": [
      "21 CFR Part 11 §11.10(e) — Audit Trails",
      "HIPAA Security Rule §164.312(c)(1) — Integrity",
      "ISO/IEC 27001:2022 A.8.15 — Logging"
    ],
    "domain": "healthcare",
    "pattern": "approval-chain"
  },
  "identity.privileged.grant": {
    "requires": [
      "approval",
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "soc2"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.2 — Privileged Access Rights",
      "NIST SP 800-53 Rev.5 AC-6 — Least Privilege",
      "SOC 2 CC6.1 — Logical Access Controls"
    ],
    "domain": "identity",
    "pattern": "approval-chain"
  },
  "agent.tool.invoke": {
    "requires": [
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "risk"
    ],
    "frameworks": [
      "eu_ai_act",
      "nist_800_53"
    ],
    "controls": [
      "EU AI Act Art. 14 — Human Oversight",
      "NIST SP 800-53 Rev.5 AC-3 — Access Enforcement"
    ],
    "domain": "agent",
    "pattern": "role-only"
  },
  "model.promote": {
    "requires": [
      "approval",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "model_trust"
    ],
    "frameworks": [
      "eu_ai_act",
      "iso27001"
    ],
    "controls": [
      "EU AI Act Art. 9 — Risk Management System",
      "ISO/IEC 27001:2022 A.8.32 — Change Management"
    ],
    "domain": "agent",
    "pattern": "approval-chain"
  },
  "data.export": {
    "requires": [
      "approval"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "consent",
      "residency"
    ],
    "frameworks": [
      "gdpr",
      "hipaa"
    ],
    "controls": [
      "GDPR Art. 20 — Right to Data Portability / Art. 44 — Transfers",
      "HIPAA Security Rule §164.312(b) — Audit Controls"
    ],
    "domain": "data",
    "pattern": "approval-chain"
  },
  "security.breakglass": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "risk"
    ],
    "frameworks": [
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "NIST SP 800-53 Rev.5 AC-6(9) — Auditing Use of Privileged Functions",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "security",
    "pattern": "human-only"
  },
  "release.create": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management",
      "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control"
    ],
    "domain": "production",
    "pattern": "role-only"
  },
  "production.rollback": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management",
      "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control"
    ],
    "domain": "production",
    "pattern": "role-only"
  },
  "database.migrate": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management",
      "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "infrastructure",
    "pattern": "approval-chain"
  },
  "infrastructure.change": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "pci_dss"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management",
      "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
      "NIST SP 800-53 Rev.5 SI-4 — System Monitoring",
      "PCI DSS v4.0 Req. 1 — Install and Maintain Network Security Controls"
    ],
    "domain": "infrastructure",
    "pattern": "approval-chain"
  },
  "feature.enable": {
    "requires": [],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.32 — Change Management"
    ],
    "domain": "production",
    "pattern": "role-only"
  },
  "secret.rotate": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "pci_dss"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.17 — Authentication Information",
      "NIST SP 800-53 Rev.5 IA-5 — Authenticator Management",
      "PCI DSS v4.0 Req. 3 — Protect Stored Account Data (key management)"
    ],
    "domain": "privileged",
    "pattern": "role-only"
  },
  "traffic.failover": {
    "requires": [
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.14 — Redundancy of Information Processing Facilities",
      "NIST SP 800-53 Rev.5 CP-10 — System Recovery and Reconstitution"
    ],
    "domain": "infrastructure",
    "pattern": "role-only"
  },
  "host.isolate": {
    "requires": [
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.26 — Response to Information Security Incidents",
      "NIST SP 800-53 Rev.5 IR-4 — Incident Handling"
    ],
    "domain": "infrastructure",
    "pattern": "role-only"
  },
  "protocol.amend": {
    "requires": [
      "approval",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "regulatory"
    ],
    "frameworks": [
      "cfr_part_11",
      "eu_annex_11",
      "ich_e6_gcp"
    ],
    "controls": [
      "21 CFR 312.30 — IND Protocol Amendments",
      "EU Annex 11 §1 (Risk Management) / Clinical Trials Regulation substantial modifications",
      "ICH E6(R2) §4.5 — Compliance with Protocol / §3.3 (IRB/IEC)"
    ],
    "domain": "clinical",
    "pattern": "approval-chain"
  },
  "employment.terminate": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.6.5 — Responsibilities after termination or change of employment",
      "NIST SP 800-53 Rev.5 PS-4 — Personnel Termination",
      "SOX §404 — segregation of duties over the employment/payroll decision"
    ],
    "domain": "people",
    "pattern": "approval-chain"
  },
  "compensation.change": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "people",
    "pattern": "approval-chain"
  },
  "journal.post": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "period.close": {
    "requires": [
      "approval",
      "state-snapshot"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "trial.biomarker.reclassify": {
    "requires": [
      "approval",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "regulatory"
    ],
    "frameworks": [
      "cfr_part_11",
      "gxp_general",
      "ich_e6_gcp"
    ],
    "controls": [
      "21 CFR Part 11 §11.10(b) — Accurate and Complete Copies",
      "21 CFR Part 11 §11.10(e) — Reason for Change",
      "ICH E6(R2) §5.5.3 — Electronic Data Handling / Audit Trail",
      "ICH E9 §5 — Data Handling / Integrity of Trial Results"
    ],
    "domain": "clinical",
    "pattern": "approval-chain"
  },
  "trial.biomarker.eligibility.override": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "regulatory"
    ],
    "frameworks": [
      "cfr_part_11",
      "gxp_general",
      "ich_e6_gcp"
    ],
    "controls": [
      "21 CFR 312.66 — Assurance of IRB Review / Investigator Obligations",
      "ICH E6(R2) §4.5.3–4 — Compliance with Protocol / Deviations",
      "ICH E9 §5.2 — Analysis Sets / Protocol Deviations"
    ],
    "domain": "clinical",
    "pattern": "approval-chain"
  },
  "genomic.data.release": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "consent",
      "identity",
      "sensitivity"
    ],
    "frameworks": [
      "gdpr",
      "hipaa",
      "iso27001"
    ],
    "controls": [
      "GDPR Art. 9 — Special Categories / Art. 6 — Lawfulness",
      "HIPAA §164.508 — Authorization / §164.312(b) — Audit Controls",
      "ISO/IEC 27001:2022 A.8.15 — Logging / A.5.34 — Privacy & PII"
    ],
    "domain": "data",
    "pattern": "approval-chain"
  },
  "genomic.data.export": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "consent",
      "residency",
      "sensitivity"
    ],
    "frameworks": [
      "gdpr",
      "iso27001"
    ],
    "controls": [
      "GDPR Art. 44–49 — Transfers of Personal Data to Third Countries",
      "GDPR Art. 9 — Special Categories (Genetic Data)",
      "ISO/IEC 27001:2022 A.5.34 — Privacy & PII / A.8.15 — Logging"
    ],
    "domain": "data",
    "pattern": "approval-chain"
  },
  "communication.external.send": {
    "requires": [
      "approval"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "gdpr",
      "hipaa",
      "soc2"
    ],
    "controls": [
      "GDPR Art. 5(1)(f) — Integrity and Confidentiality / Art. 44 — Transfers",
      "HIPAA Security Rule §164.312(e) — Transmission Security",
      "SOC 2 CC6.7 — Data Transmission and Disposal Controls"
    ],
    "domain": "data",
    "pattern": "approval-chain"
  },
  "trial.randomization.break": {
    "requires": [
      "approval",
      "mfa"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "cfr_part_11",
      "ich_e6_gcp"
    ],
    "controls": [
      "21 CFR Part 11 §11.300 — Controls for Identification Codes",
      "ICH E6(R2) §4.8 — Breaking the Blind (subject-level)"
    ],
    "domain": "clinical",
    "pattern": "human-only"
  },
  "reconciliation.certify": {
    "requires": [
      "approval",
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "SOX §302 / §404 — Officer Certification of Internal Controls"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "journal_entry.approve": {
    "requires": [
      "approval",
      "mfa",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
      "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
      "SOX ITGC — Manual Journal Entry Segregation of Duties"
    ],
    "domain": "finance",
    "pattern": "four-eyes"
  },
  "variance_review.escalate": {
    "requires": [
      "approval"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [],
    "frameworks": [
      "sox"
    ],
    "controls": [
      "SOX §404 — Management Assessment of Internal Controls"
    ],
    "domain": "finance",
    "pattern": "human-only"
  },
  "industrial.safety.bypass": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity",
      "risk"
    ],
    "frameworks": [
      "api_rp_754",
      "iec_61511",
      "osha_psm"
    ],
    "controls": [
      "29 CFR 1910.119(l) — Management of Change",
      "API RP 754 — Process Safety Performance Indicators (Tier 1/2 near-miss basis)",
      "IEC 61511-1 Cl. 16.2.3 / 11.2.11 — Bypass and Override Management"
    ],
    "domain": "industrial",
    "pattern": "human-only"
  },
  "industrial.controller.configure": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity",
      "supply_chain"
    ],
    "frameworks": [
      "iec_62443",
      "nerc_cip"
    ],
    "controls": [
      "IEC 62443-3-3 SR 3.4 — Software and Information Integrity",
      "IEC 62443-3-3 SR 7.6 — Network and Security Configuration Settings",
      "NERC CIP-010-4 — Configuration Change Management and Vulnerability Assessments"
    ],
    "domain": "industrial",
    "pattern": "approval-chain"
  },
  "secret.configuration.change": {
    "requires": [
      "approval",
      "mfa",
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "iso27001",
      "nist_800_53",
      "pci_dss"
    ],
    "controls": [
      "ISO/IEC 27001:2022 A.8.2 — Privileged Access Rights",
      "NIST SP 800-53 Rev.5 AC-6 — Least Privilege",
      "PCI DSS v4.0 Req. 7 — Restrict Access to System Components"
    ],
    "domain": "infrastructure",
    "pattern": "approval-chain"
  },
  "sensitive_data.access": {
    "requires": [
      "state-snapshot",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "identity",
      "sensitivity"
    ],
    "frameworks": [
      "gdpr",
      "hipaa",
      "nist_800_53"
    ],
    "controls": [
      "GDPR Art. 5(1)(b)-(c) — Purpose Limitation and Data Minimisation",
      "HIPAA Security Rule §164.312(a)(1) — Access Control",
      "NIST SP 800-53 Rev.5 AC-3 — Access Enforcement"
    ],
    "domain": "data",
    "pattern": "role-only"
  },
  "submission.submit": {
    "requires": [
      "approval",
      "verified-actor"
    ],
    "produces": [
      "audit-chain",
      "permit"
    ],
    "assertions": [
      "approval",
      "identity"
    ],
    "frameworks": [
      "cfr_part_11",
      "nist_800_53",
      "sox"
    ],
    "controls": [
      "21 CFR Part 11 §11.10(e) — Audit Trails for Electronic Records",
      "NIST SP 800-53 AC-3 — Access Enforcement",
      "SOX §404 — Internal Control over Financial Reporting (filing authorization)"
    ],
    "domain": "data",
    "pattern": "approval-chain"
  }
};
