// GENERATED-DERIVED — do not edit directly.
// Source: atlasent/generated/act-spec-index.json (from contract/canonical-actions/ACT-*.yaml)
// Regenerate: node scripts/sync-canon.mjs (from a checkout with ../atlasent present)

export interface ActSpecGateFlags {
  requires_human_approval: boolean;
  requires_mfa: boolean;
  requires_verified_actor: boolean;
  requires_state_snapshot: boolean;
  required_assertion_classes: string[];
}

export interface ActSpecAuthorizationPattern {
  type: string;
  machine_executable: boolean;
  minimum_approvals?: number;
}

export interface ActSpecEntry {
  id: string;
  /** Permanent immutable identifier (CANON-NNNNNN). Stable across slug changes. */
  canon_id: string;
  slug: string;
  display_name: string;
  description: string;
  family: string;
  risk_posture: string;
  ai_risk: string;
  gate_flags: ActSpecGateFlags;
  authorization_pattern: ActSpecAuthorizationPattern;
  regulatory_mappings: Record<string, unknown>[];
  evidence_requirements: Record<string, unknown>;
  use_case: string;
  industries: string[];
}

export const CANON_ACT_CATALOG: ActSpecEntry[] = [
  {
    "id": "ACT-0001",
    "canon_id": "CANON-000001",
    "slug": "production.deploy",
    "display_name": "Execute Authorized Change or Deployment Plan",
    "description": "Authorization gate for executing an authorized change or deployment plan against a target system. This spans deploying code, configuration, or infrastructure to a production environment AND applying an authorized change plan to an enterprise business system — for example a CI/CD deployment, or a configuration / permission / workflow / financial-control change plan applied to a system such as a CRM or ERP. These executions carry high blast radius: an unauthorized or insufficiently-reviewed change can cause outages, data corruption, or security/compliance exposure. Every execution must be traceable to a tamper-evident permit bound to the exact canonical plan, with an auditable approval chain.",
    "family": "production.deploy",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls",
        "mapping": "AtlaSent captures a tamper-evident permit for every production deployment, proving change control gates ran with named approvers, timestamps, and audit-chain linkage. Satisfies PCAOB AS 2201 change management evidence requirements.\n",
        "evidence_source": "audit_chain",
        "status_query": "deployment_change_control_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "Deployment permits provide the documented authorization record ISO 27001 requires before changes reach production systems.\n",
        "evidence_source": "permit_record",
        "status_query": "change_management_permit_coverage"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
        "mapping": "AtlaSent enforces the approval, documentation, and audit requirements of CM-3 at deploy time rather than as a post-hoc review.\n",
        "evidence_source": "audit_chain",
        "status_query": "cm3_deploy_gate_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "State snapshot captures a canonical plan digest — a git SHA, image digest, Terraform plan hash, or the digest of a business-system change plan (e.g. a Salesforce change set or NetSuite SDF project) — at authorization time, binding the permit to the exact plan executed.\n"
    },
    "use_case": "Gate every production deployment behind a tamper-evident permit with named approvers, change window enforcement, and an offline-verifiable audit chain — so auditors can prove who authorized what, when, and with what evidence.",
    "industries": [
      "fintech",
      "healthtech",
      "saas",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0002",
    "canon_id": "CANON-000002",
    "slug": "artifact.release",
    "display_name": "Artifact Release",
    "description": "Authorization gate for publishing a versioned artifact to a public or private distribution channel — npm, PyPI, crates.io, Docker Hub, Maven Central, GitHub Releases, or any package registry. Once published, an artifact is consumed by downstream systems; a malicious or compromised release propagates silently through the supply chain. Requires cryptographically verified actor identity to close the spoofed-actor attack surface.",
    "family": "production.deploy",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "supply_chain"
      ]
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 SA-12 — Supply Chain Protection",
        "mapping": "AtlaSent permits for artifact releases provide the documented authorization chain NIST SA-12 requires for software components entering the supply chain.\n",
        "evidence_source": "permit_record",
        "status_query": "artifact_release_permit_coverage"
      },
      {
        "framework": "eu_ai_act",
        "clause": "EU AI Act Art. 11 (Annex IV) — Technical Documentation",
        "mapping": "For AI system components, release permits create the documented deployment authorization trail required for EU AI Act conformance assessments.\n",
        "evidence_source": "audit_chain",
        "status_query": "ai_artifact_release_documentation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "required_assertions": [
        "supply_chain"
      ],
      "notes": "State snapshot should include the artifact content hash and the registry destination. The supply_chain assertion provides SLSA-level provenance.\n"
    },
    "use_case": "Prevent unauthorized or compromised actors from publishing packages to npm, PyPI, crates.io, or any registry. Every release is gated behind a cryptographically verified actor identity and a supply chain assertion binding the artifact hash.",
    "industries": [
      "saas",
      "developer-tools",
      "fintech",
      "enterprise",
      "open-source"
    ]
  },
  {
    "id": "ACT-0003",
    "canon_id": "CANON-000003",
    "slug": "workflow.approve",
    "display_name": "Workflow Approval",
    "description": "Authorization gate for recording a human approval decision within a multi-step workflow. An approval is definitionally a human act — it attests that a qualified person reviewed content and authorizes progression. Machine-generated approvals are not approvals; they are automated checks. This action requires a human actor to prevent AI systems from self-approving workflow steps they participate in — the AI self-approval loop that regulators are now mandating controls for.",
    "family": "production.deploy",
    "risk_posture": "standard",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §302 — Corporate Responsibility for Financial Reports",
        "mapping": "Financial reporting approvals require a human officer. AtlaSent records the approval actor, timestamp, and permit chain proving a human (not an automated system) authorized the progression.\n",
        "evidence_source": "audit_chain",
        "status_query": "workflow_approval_human_pct"
      },
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 22 — Automated Individual Decision-Making",
        "mapping": "For workflows affecting data subjects, human approval gates provide the meaningful human involvement GDPR Art. 22 requires when significant decisions involve automated processing.\n",
        "evidence_source": "evaluation_record",
        "status_query": "gdpr_human_approval_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": true,
      "state_snapshot_required": false
    },
    "use_case": "Prevent AI agents from approving their own outputs or advancing workflows they participate in. Every workflow approval is gated to verified human actors — closing the AI self-approval loop that regulators are now requiring controls for.",
    "industries": [
      "fintech",
      "healthtech",
      "regulated-industries",
      "enterprise",
      "legal"
    ]
  },
  {
    "id": "ACT-0005",
    "canon_id": "CANON-000004",
    "slug": "data.modify",
    "display_name": "Data Modification",
    "description": "Authorization gate for modifications to regulated, critical, or shared data. Data modifications have broad downstream effects — corrupted records in healthcare, financial, or compliance contexts can propagate silently and are difficult to reverse. State snapshot binding captures the pre-modification state, enabling rollback evidence and satisfying reason-for-change requirements under 21 CFR Part 11 §11.10(e).",
    "family": "data.access",
    "risk_posture": "standard",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 5(1)(d) — Accuracy Principle",
        "mapping": "AtlaSent records who modified data, when, and with what authorization, satisfying GDPR accountability requirements for data accuracy and auditability of changes.\n",
        "evidence_source": "audit_chain",
        "status_query": "data_modification_audit_coverage"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.312(c)(1) — Integrity Controls",
        "mapping": "AtlaSent provides the access controls and audit trail HIPAA requires to protect electronic protected health information from improper alteration or destruction.\n",
        "evidence_source": "evaluation_record",
        "status_query": "phi_modification_gate_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(e) — Audit Trails",
        "mapping": "AtlaSent captures the reason-for-change and actor identity for every data modification, satisfying FDA electronic records audit trail requirements.\n",
        "evidence_source": "audit_chain",
        "status_query": "cfr11_reason_for_change_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture a hash of the record before modification. The reason field (21 CFR Part 11 §11.10(e)) should be included in the evaluate request context.\n"
    },
    "use_case": "Gate all modifications to regulated data (PHI, financial records, clinical trial data) with actor attribution, state snapshots, and reason-for-change capture — satisfying FDA, HIPAA, and GDPR audit trail requirements.",
    "industries": [
      "healthtech",
      "fintech",
      "life-sciences",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0007",
    "canon_id": "CANON-000005",
    "slug": "data.import",
    "display_name": "Data Import",
    "description": "Authorization gate for ingesting external data into regulated or production systems — ETL pipelines, third-party data feeds, clinical trial data imports, financial data onboarding, and AI training data ingestion. Imported data can introduce corruption, malicious content, or unvalidated records into clean systems. State snapshot binding captures the source dataset hash, satisfying data provenance requirements under 21 CFR Part 11 and HIPAA.",
    "family": "data.access",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.308(a)(1) — Security Management Process",
        "mapping": "AtlaSent gates data imports from external sources, ensuring only authorized actors can introduce external data into systems containing ePHI.\n",
        "evidence_source": "evaluation_record",
        "status_query": "phi_import_gate_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10 — Controls for Closed Systems",
        "mapping": "AtlaSent ensures data imported into validated systems carries authorization evidence and a source hash binding the import to a specific dataset version.\n",
        "evidence_source": "audit_chain",
        "status_query": "cfr11_data_import_pct"
      },
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 25 — Data Protection by Design and by Default",
        "mapping": "Authorization controls at import time implement data protection by design, preventing unauthorized or unvalidated data from entering systems that process personal data.\n",
        "evidence_source": "permit_record",
        "status_query": "gdpr_import_authorization_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should include the source dataset hash and record count. For clinical data, include the CRF version or EDC export timestamp.\n"
    },
    "use_case": "Gate all data imports from external sources — clinical trial data, financial feeds, third-party vendors — with integrity verification and authorization permits that prove what was imported, by whom, and from where.",
    "industries": [
      "healthtech",
      "life-sciences",
      "fintech",
      "enterprise"
    ]
  },
  {
    "id": "ACT-0008",
    "canon_id": "CANON-000006",
    "slug": "data.delete",
    "display_name": "Data Deletion",
    "description": "Authorization gate for deletion of regulated, irreplaceable, or legally significant data. Deletions are irreversible in most systems; unauthorized deletion can result in permanent data loss, GDPR erasure obligation violations (proving deletion happened), and destruction of records required to be retained under SOX or HIPAA. State snapshot binding captures what existed at deletion time for erasure certificates and retention audits.",
    "family": "data.access",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 17 — Right to Erasure",
        "mapping": "AtlaSent records who authorized the deletion, when, and with what evidence — creating the documented erasure record GDPR Art. 17 requires to demonstrate compliance with erasure requests.\n",
        "evidence_source": "audit_chain",
        "status_query": "gdpr_erasure_documentation_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.530(j) — Retention Requirements",
        "mapping": "AtlaSent creates an immutable record of authorized deletions, enabling HIPAA-compliant demonstration that data was deleted as required or retained as mandated.\n",
        "evidence_source": "permit_record",
        "status_query": "phi_deletion_authorization_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §802 — Criminal Penalties for Altering Documents",
        "mapping": "AtlaSent's permit chain proves deletions were authorized and executed within proper governance — distinguishing legitimate record management from document destruction.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_deletion_governance_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture a hash of the records being deleted and a count. For GDPR erasure, include the data subject identifier in the evaluate context.\n"
    },
    "use_case": "Gate all data deletions with documented authorization, state snapshots, and reason capture — creating erasure certificates for GDPR Art. 17 compliance and preventing AI agents from autonomously deleting production data.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0009",
    "canon_id": "CANON-000007",
    "slug": "access.grant",
    "display_name": "Access Grant",
    "description": "Authorization gate for granting privileged access — IAM roles, group memberships, elevated permissions, API key provisioning, and service account grants. Access grants are the most consequential identity operation: they expand the privilege surface permanently until revoked. Unauthorized grants enable privilege escalation, lateral movement, and persistent access for attackers. Requires human approval and quorum to prevent unilateral privilege escalation.",
    "family": "identity.grant",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "quorum",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Access Control as Internal Control",
        "mapping": "AtlaSent creates a tamper-evident permit for every access grant, proving privileged access was authorized through a documented human approval chain — satisfying PCAOB access control evidence requirements.\n",
        "evidence_source": "audit_chain",
        "status_query": "access_grant_human_approval_pct"
      },
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 7 — Restrict Access to System Components",
        "mapping": "AtlaSent enforces the authorization requirement before any access grant, ensuring the principle of least privilege is enforced with documented human approval.\n",
        "evidence_source": "permit_record",
        "status_query": "pci_access_grant_authorization_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.308(a)(3) — Workforce Access Management",
        "mapping": "AtlaSent gates access grants to ePHI systems with human approval and audit trail, satisfying HIPAA workforce access management requirements.\n",
        "evidence_source": "evaluation_record",
        "status_query": "hipaa_access_grant_gate_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-2 — Account Management",
        "mapping": "AtlaSent enforces the formal approval requirement of NIST AC-2(b) — the authorization request and approval must be documented before access is granted.\n",
        "evidence_source": "audit_chain",
        "status_query": "nist_ac2_access_grant_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture the current access configuration before the grant. The approval artifact must contain the business justification for the access request.\n"
    },
    "use_case": "Enforce two-person integrity for all privileged access grants — IAM roles, group memberships, elevated permissions. Every grant requires human approval with a documented business justification and a tamper-evident audit chain.",
    "industries": [
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries",
      "saas"
    ]
  },
  {
    "id": "ACT-0010",
    "canon_id": "CANON-000008",
    "slug": "access.revoke",
    "display_name": "Access Revocation",
    "description": "Authorization gate for revoking access — removing IAM roles, group memberships, elevated permissions, or deprovisioning accounts. Unlike access grants, revocations are often time-critical during security incidents; requiring human approval would delay incident response. Instead, this action gates revocations with role verification and an immutable audit trail, ensuring every revocation is attributed and documented without blocking the speed needed for offboarding or incident containment.",
    "family": "identity.grant",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-2(j) — Account Management: Disable Accounts",
        "mapping": "AtlaSent ensures every access revocation is attributed, timestamped, and linked to an immutable audit event — satisfying NIST AC-2(j) requirements for timely account disabling with documented evidence.\n",
        "evidence_source": "audit_chain",
        "status_query": "access_revoke_audit_coverage"
      },
      {
        "framework": "sox",
        "clause": "SOX §404 — Termination and Access Removal Controls",
        "mapping": "AtlaSent creates a tamper-evident record of access removals, proving terminated employees and contractors lost access within the required timeframe — a standard SOX §404 evidence point.\n",
        "evidence_source": "permit_record",
        "status_query": "sox_offboarding_revoke_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture the access configuration being revoked. Include the revocation reason (offboarding, incident response, role change) in evaluate context.\n"
    },
    "use_case": "Create an immutable audit trail for every access revocation — offboarding, incident response, role changes — without slowing down the revocation speed needed during security incidents.",
    "industries": [
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0011",
    "canon_id": "CANON-000009",
    "slug": "control.override",
    "display_name": "Control Override",
    "description": "Authorization gate for bypassing a security or compliance control — break-glass access, policy exceptions, emergency overrides, firewall rule bypasses, and regulatory exemptions. Control overrides are the highest-risk action class: they deliberately disable a protective control, creating a window of elevated risk. Every override must be justified, attributed to a verified human actor with MFA, and the risk must be contemporaneously assessed. AI agents must never override security controls autonomously.",
    "family": "privileged.operation",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "risk",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 10.2 — Audit Logs for Security Control Bypasses",
        "mapping": "AtlaSent creates an immutable record of every security control bypass with the identity of the actor, the risk assessment, and the justification — satisfying PCI DSS requirements for override logging.\n",
        "evidence_source": "audit_chain",
        "status_query": "pci_override_audit_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §404 — Override of Internal Controls",
        "mapping": "AtlaSent ensures overrides of internal controls are documented with the authorizer's identity and business justification, satisfying PCAOB requirements for management override documentation.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_override_documentation_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-17 — Remote Access",
        "mapping": "AtlaSent gates emergency access overrides with MFA, verified actor identity, and contemporaneous risk assessment — satisfying NIST AC-17 requirements for monitored and controlled privileged remote access.\n",
        "evidence_source": "permit_record",
        "status_query": "nist_override_gate_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "risk",
        "identity"
      ],
      "notes": "The risk assertion must describe the specific control being bypassed and the accepted risk. The identity assertion proves the actor is who they claim to be at override time. Both must be present for the permit to be issued.\n"
    },
    "use_case": "Gate every security control override — break-glass access, emergency bypasses, policy exceptions — with MFA, verified identity, human approval, and a contemporaneous risk assessment. Every override is permanently attributed and auditable.",
    "industries": [
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries",
      "government"
    ]
  },
  {
    "id": "ACT-0013",
    "canon_id": "CANON-000010",
    "slug": "content.publish",
    "display_name": "Content Publication",
    "description": "Authorization gate for publishing regulated content — medical device documentation, IFUs, SOPs, labeling, regulatory submissions, clinical study reports, and controlled documents. In regulated industries, a document released without proper authorization constitutes a quality system non-conformance. State snapshot binding captures the document hash at publication time, enabling version traceability.",
    "family": "regulated.release",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10 — Controls for Closed Systems",
        "mapping": "AtlaSent captures the author identity, document hash, and authorization record for every content publication — satisfying FDA document control requirements for electronic records in validated systems.\n",
        "evidence_source": "audit_chain",
        "status_query": "cfr11_content_publish_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.37 — Documented Operating Procedures",
        "mapping": "AtlaSent ensures documented operating procedures are published through an authorized channel with an immutable record of who released the document and when.\n",
        "evidence_source": "permit_record",
        "status_query": "iso27001_documented_procedures_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot must include the document hash (SHA-256 of final content) and the document version number. For FDA submissions, include the eCTD sequence number.\n"
    },
    "use_case": "Gate publication of all regulated documents — medical device IFUs, SOPs, labeling, clinical study reports — with document hash binding and author attribution, creating a tamper-evident record of every controlled document release.",
    "industries": [
      "life-sciences",
      "healthtech",
      "medtech",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0014",
    "canon_id": "CANON-000011",
    "slug": "identity.sign",
    "display_name": "Identity Signature",
    "description": "Authorization gate for electronic signature acts — signing regulated documents, certifying records, and affixing a legally significant identity to a decision. Electronic signatures are legal acts requiring human intent under 21 CFR Part 11, EU eIDAS, and the US eSign Act. This action structurally prevents machine execution: no AI agent, service account, or automated system can sign on behalf of a human. Requires MFA and identity + approval assertions to bind the signer's identity to the signature act.",
    "family": "identity.grant",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.50 — Signature Manifestations",
        "mapping": "AtlaSent captures the printed name, date/time, and meaning of each electronic signature in the permit chain — satisfying FDA requirements that signatures be bound to the record with legal meaning.\n",
        "evidence_source": "audit_chain",
        "status_query": "cfr11_esignature_meaning_pct"
      },
      {
        "framework": "eidas",
        "clause": "eIDAS Reg. (EU) 910/2014 Art. 3(9), Art. 26 — Signatory Is a Natural Person; Advanced Electronic Signatures",
        "mapping": "AtlaSent ensures AI systems cannot sign as qualified signatories under eIDAS — the identity assertion requires a human principal, not an AI actor ID.\n",
        "evidence_source": "permit_record",
        "status_query": "eidas_human_signature_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §302 — CEO/CFO Certification",
        "mapping": "AtlaSent gates executive certifications with MFA and identity assertion, proving a human officer (not an automated system) affixed their signature to the certification.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_302_human_signatory_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-04",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "identity",
        "approval"
      ],
      "notes": "The identity assertion must carry the signer's legal name and IdP-verified principal. The approval assertion must reference the specific document hash being signed. The approval_meaning field must capture what the signer is attesting to (21 CFR Part 11 §11.50(a)(2)).\n"
    },
    "use_case": "Gate all regulated electronic signature acts — batch release certifications, clinical study reports, SOX officer certifications, EU AI Act conformity declarations — with MFA and identity assertions that prove a verified human (not AI) signed.",
    "industries": [
      "life-sciences",
      "healthtech",
      "fintech",
      "regulated-industries",
      "legal"
    ]
  },
  {
    "id": "ACT-0015",
    "canon_id": "CANON-000012",
    "slug": "resource.create",
    "display_name": "Resource Creation",
    "description": "Authorization gate for creation of cloud resources, databases, infrastructure components, and managed services. Resource creation is the origin point of all infrastructure; without attribution at creation time, the lineage of production resources is opaque. State snapshot binding captures the desired configuration at authorization time, preventing configuration drift between approval and provisioning.",
    "family": "infrastructure.change",
    "risk_posture": "standard",
    "ai_risk": "Low",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Change Management for IT Systems",
        "mapping": "AtlaSent attributes every resource creation to an authorized actor with an immutable timestamp — satisfying SOX change management documentation requirements for new IT system components.\n",
        "evidence_source": "audit_chain",
        "status_query": "resource_create_attribution_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.1 — Inventory of Assets",
        "mapping": "AtlaSent's permit chain creates an authoritative record of every resource creation, supporting the asset inventory requirements of ISO 27001 A.8.1.\n",
        "evidence_source": "permit_record",
        "status_query": "iso27001_asset_creation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should include the Terraform plan hash or cloud configuration manifest hash at authorization time. Include the target region and resource type.\n"
    },
    "use_case": "Attribute every cloud resource creation to an authorized actor with a configuration hash — preventing shadow IT, enabling asset lifecycle governance, and satisfying SOX and ISO 27001 change management requirements.",
    "industries": [
      "saas",
      "enterprise",
      "fintech",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0016",
    "canon_id": "CANON-000013",
    "slug": "resource.destroy",
    "display_name": "Resource Destruction",
    "description": "Authorization gate for irreversible destruction of cloud resources, databases, storage buckets, and infrastructure components. Resource destruction is one of the highest-risk infrastructure operations — a mistaken or unauthorized destroy can cause catastrophic data loss, extended outages, and regulatory violations. Requires the strongest gate: human approval, MFA, verified actor identity, and a contemporaneous risk assessment proving the actor understood the consequences before proceeding.",
    "family": "infrastructure.change",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "risk",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "quorum",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.310(d)(2)(i) — Media Disposal",
        "mapping": "AtlaSent creates an authorized destruction record proving data was deliberately destroyed by an authorized actor — satisfying HIPAA disposal documentation requirements.\n",
        "evidence_source": "audit_chain",
        "status_query": "hipaa_disposal_authorization_pct"
      },
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 17 — Right to Erasure",
        "mapping": "AtlaSent's destruction permit proves irreversible deletion was authorized and executed, providing the documented erasure evidence GDPR Art. 17 requires.\n",
        "evidence_source": "permit_record",
        "status_query": "gdpr_destruction_documentation_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §802 — Document Retention and Destruction",
        "mapping": "AtlaSent ensures resource destruction is authorized through proper governance and distinguishes legitimate decommissioning from unauthorized destruction of SOX-relevant systems.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_destruction_governance_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "risk",
        "identity"
      ],
      "notes": "The risk assertion must identify the specific resources being destroyed and confirm the actor understands the irreversibility. The identity assertion proves both approvers are who they claim to be.\n"
    },
    "use_case": "Prevent catastrophic data loss from unauthorized or mistaken infrastructure destruction. Every destroy operation requires two human approvers with MFA, verified identities, and a contemporaneous risk assessment — no AI agent or solo admin can destroy production resources.",
    "industries": [
      "fintech",
      "healthtech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0017",
    "canon_id": "CANON-000014",
    "slug": "service.suspend",
    "display_name": "Service Suspension",
    "description": "Authorization gate for deliberate suspension of a production service — taking a service offline for maintenance, as an incident response action, or as a business decision. Service suspension has direct customer impact through SLA obligations and availability commitments. State snapshot binding captures the pre-suspension service state, enabling documented justification and post-suspension comparison.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.14 — Redundancy of Information Processing Facilities",
        "mapping": "AtlaSent documents every deliberate service suspension with actor identity and business justification — satisfying ISO 27001 change management requirements for availability decisions.\n",
        "evidence_source": "audit_chain",
        "status_query": "service_suspend_documented_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture the service health metrics at suspension time — error rate, latency p99, active connections. Include the expected suspension duration and customer impact scope in the evaluate context.\n"
    },
    "use_case": "Document every deliberate service suspension with actor attribution, service state snapshot, and justification — creating the governance record needed for SLA compliance and post-incident reviews.",
    "industries": [
      "saas",
      "fintech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0018",
    "canon_id": "CANON-000015",
    "slug": "service.resume",
    "display_name": "Service Resumption",
    "description": "Authorization gate for resuming a suspended service — bringing a service back online after planned or emergency maintenance. Service resumption carries its own risks: resuming a service before the underlying issue is resolved can cause immediate re-failure. State snapshot binding captures the post-fix service configuration, enabling documented validation that the root cause was addressed before resumption.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.14 — Redundancy and Recovery",
        "mapping": "AtlaSent documents every service resumption with actor identity and validation evidence — satisfying ISO 27001 requirements for documented recovery procedures.\n",
        "evidence_source": "audit_chain",
        "status_query": "service_resume_documented_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "State snapshot should capture the post-fix service configuration. Include the root cause summary and validation steps completed in the evaluate context — these become the SLA restoration evidence.\n"
    },
    "use_case": "Document every service resumption with actor attribution, post-fix configuration state, and root cause summary — creating the SLA restoration evidence and post-incident closure record that compliance and customers require.",
    "industries": [
      "saas",
      "fintech",
      "enterprise"
    ]
  },
  {
    "id": "ACT-0019",
    "canon_id": "CANON-000016",
    "slug": "workflow.escalate",
    "display_name": "Workflow Escalation",
    "description": "Authorization gate for workflow escalation steps — capturing the moment when an AI agent, automated system, or human acknowledges it cannot proceed without additional authority and escalates to a higher-level decision maker. Escalation is intentionally low-friction (any-role, no human approval gate) because the goal is to capture and attribute escalations, not to gate them. A well-documented escalation trail proves AI agents recognized their limits and deferred to humans rather than proceeding autonomously.",
    "family": "production.deploy",
    "risk_posture": "standard",
    "ai_risk": "Low",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "any-role",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Escalation Procedures as Internal Controls",
        "mapping": "AtlaSent creates an immutable record of escalation events, proving that exception-handling procedures were followed and escalations were properly attributed and documented.\n",
        "evidence_source": "audit_chain",
        "status_query": "escalation_audit_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": false,
      "notes": "The evaluate context should include the escalation reason, the decision being escalated, and the target escalation recipient. This context becomes the escalation evidence in the audit chain.\n"
    },
    "use_case": "Create an audit trail of every escalation event — proving AI agents recognized their limits and deferred to humans rather than proceeding autonomously. The escalation chain becomes evidence of appropriate human-AI collaboration.",
    "industries": [
      "saas",
      "enterprise",
      "regulated-industries",
      "fintech",
      "healthtech"
    ]
  },
  {
    "id": "ACT-0020",
    "canon_id": "CANON-000017",
    "slug": "compliance.certify",
    "display_name": "Compliance Certification",
    "description": "Authorization gate for compliance certification acts — EU AI Act declarations of conformity, SOX §302 CEO/CFO certifications, GxP Qualified Person batch release certifications, HIPAA compliance officer certifications, and ISO/IEC conformity attestations. These are legal acts performed by a qualified authority with personal accountability. No AI system may certify compliance on behalf of a human — this action is structurally machine-blocked. Requires MFA, a qualified human authority, and regulatory + identity + approval assertions proving the certifier understood and accepted the obligations they are certifying.",
    "family": "regulated.release",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "regulatory",
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "eu_ai_act",
        "clause": "EU AI Act Art. 47-49 — Declaration of Conformity",
        "mapping": "AtlaSent gates conformity declarations with a qualified human authority, MFA, and a regulatory assertion confirming the specific requirements being certified — proving the declaration was made by a natural person, not an automated system.\n",
        "evidence_source": "audit_chain",
        "status_query": "eu_ai_act_declaration_human_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §302 — Corporate Responsibility for Financial Reports",
        "mapping": "AtlaSent ensures SOX §302 certifications are performed by the human CEO/CFO with MFA, creating a tamper-evident record that the certification was performed by a natural person with personal liability — not an automated reporting system.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_302_human_certification_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.50 — Electronic Signature Requirements for Certifications",
        "mapping": "AtlaSent captures the Qualified Person's MFA-verified signature, the meaning of the certification, and the regulatory basis — satisfying FDA requirements for electronic batch release certifications.\n",
        "evidence_source": "permit_record",
        "status_query": "cfr11_qp_certification_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.308(a)(8) — Evaluation Requirements",
        "mapping": "AtlaSent gates HIPAA compliance certifications with a compliance officer's authenticated identity — proving evaluations were performed by an authorized human officer, not an automated compliance tool.\n",
        "evidence_source": "evaluation_record",
        "status_query": "hipaa_compliance_eval_human_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "regulatory",
        "identity",
        "approval"
      ],
      "notes": "The regulatory assertion must identify the specific framework, clause, and scope being certified. The identity assertion must prove the certifier holds the required authority (e.g., QP qualification for batch release, CEO/CFO role for SOX §302). The approval assertion must capture the certification meaning (per 21 CFR Part 11 §11.50(a)(2)).\n"
    },
    "use_case": "Gate all compliance certification acts — EU AI Act conformity declarations, SOX §302 certifications, GxP QP batch releases, HIPAA compliance evaluations — with a verified human qualified authority, MFA, and regulatory + identity + approval assertions that prove a natural person certified, not an AI system.",
    "industries": [
      "life-sciences",
      "fintech",
      "regulated-industries",
      "enterprise",
      "healthtech"
    ]
  },
  {
    "id": "ACT-0021",
    "canon_id": "CANON-000018",
    "slug": "trial.unblinding.execute",
    "display_name": "Clinical Trial Unblinding",
    "description": "Authorization gate for clinical trial unblinding — the irreversible act of revealing randomized treatment assignments to investigators, sponsors, and/or analysts. Unblinding compromises the statistical integrity of ongoing blinded trials and constitutes a regulated consequential transition requiring maximum controls: dual authorization, MFA, a verified human actor, and cryptographic proof of regulatory scope, actor identity, and explicit approval assertion. No AI system or automated process may execute unblinding. Regulatory basis: ICH E6(R2) §4.8.2, 21 CFR Part 11 §11.50/§11.300, EU Annex 11 §7.1.",
    "family": "clinical.trial",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "regulatory",
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §4.8.2 — Breaking the Blind",
        "mapping": "Dual authorization by the sponsor unblinding officer and an independent data monitor is captured as two verified approval artifacts bound into the unblinding permit.\n",
        "evidence_source": "audit_chain",
        "status_query": "clinical_unblinding_dual_auth_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.50 — Signature Manifestations",
        "mapping": "The electronic signature carries an explicit approval_meaning stating the unblinding act, trial ID, and certifier role, bound into the signed audit event.\n",
        "evidence_source": "audit_chain",
        "status_query": "unblinding_esignature_meaning_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.300 — Controls for Identification Codes",
        "mapping": "Multi-factor authentication is enforced via requires_mfa; the IdP-attested acr/amr claims on the verified identity assertion prove strong authentication.\n",
        "evidence_source": "evaluation_record",
        "status_query": "unblinding_mfa_enforced_pct"
      },
      {
        "framework": "eu_annex_11",
        "clause": "EU Annex 11 §7.1 — Audit Trail",
        "mapping": "Every unblinding decision writes an immutable append-only entry to the audit chain (clinical_unblinding_events), hash-linked and Ed25519-signed.\n",
        "evidence_source": "audit_chain",
        "status_query": "unblinding_audit_trail_coverage_pct"
      },
      {
        "framework": "gxp_general",
        "clause": "ICH E9 §6 — Trial Conduct Issues / Blinding",
        "mapping": "The state snapshot captures a dataset-integrity hash at the moment of authorization, binding the permit to the trial data state via cdo_hash.\n",
        "evidence_source": "permit_record",
        "status_query": "unblinding_state_snapshot_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "regulatory",
        "identity",
        "approval"
      ],
      "approval_meaning_template": "\"I authorize the [full/partial/interim] unblinding of clinical trial [PROTOCOL_NUMBER] as [ROLE]. I confirm that [all protocol-defined unblinding criteria have been met / this is a DSMB-authorized interim analysis / database lock is confirmed]. Date: [DATE].\"\n"
    },
    "use_case": "Gate clinical trial unblinding behind dual human authorization, phishing-resistant MFA, and a cryptographically verified actor — so a sponsor can prove to the FDA or EMA that the blind was broken only by named, authorized humans with a signed, offline-verifiable audit record and an explicit §11.50 signature meaning.",
    "industries": [
      "pharma",
      "biotech",
      "cro",
      "medical-device",
      "healthtech"
    ]
  },
  {
    "id": "ACT-0022",
    "canon_id": "CANON-000019",
    "slug": "trial.blinding.setup",
    "display_name": "Clinical Trial Blind Establishment",
    "description": "Authorization gate for establishing the blind in a clinical trial — the act of sealing randomization codes, binding treatment assignments to subject IDs, and activating the blinded-data enforcement state in trial management systems (RTSM/IVRS). Blinding setup is the prerequisite that makes trial.unblinding.execute irreversible once executed; errors at setup time (wrong randomization list, incorrect stratum assignments) propagate through the entire trial. Only sponsor-designated blinding authority roles may authorize blind establishment. Requires a verified identity, supervisor review of the randomization specification, a cryptographic snapshot of the randomization list hash, and a complete audit trail per 21 CFR Part 11 §11.10(a) and EU Annex 11 §7.1. Machine callers may not execute blinding setup without explicit organizational override.",
    "family": "clinical.trial",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §5.13 — Record Access and Traceability for Blinding",
        "mapping": "The sealed list of treatment codes and the establishment of the blind are documented with the identity of the blinding authority and the date, bound into the permit.\n",
        "evidence_source": "audit_chain",
        "status_query": "blinding_setup_authority_documented_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(a) — System Validation / Accurate and Complete Records",
        "mapping": "The blind-establishment record is written at the time of the event and bound to the randomization specification hash, so the electronic record accurately and completely reflects the specification in effect.\n",
        "evidence_source": "permit_record",
        "status_query": "blinding_setup_record_accuracy_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(e) — Audit Trails for Blinded Data",
        "mapping": "The reason for blind establishment is captured with actor identity, timestamp, and trial protocol ID in the signed audit event.\n",
        "evidence_source": "audit_chain",
        "status_query": "blinding_setup_reason_capture_pct"
      },
      {
        "framework": "eu_annex_11",
        "clause": "EU Annex 11 §7.1 — Audit Trail",
        "mapping": "An immutable append-only audit entry records who established the blind, when, and against which randomization specification.\n",
        "evidence_source": "audit_chain",
        "status_query": "blinding_setup_audit_trail_pct"
      },
      {
        "framework": "ich_e9",
        "clause": "ICH E9 §3.2 — Methods of Randomization / Blinding",
        "mapping": "The randomization list and blinding method are documented and sealed before the trial starts; the state snapshot captures the randomization specification hash at setup time.\n",
        "evidence_source": "permit_record",
        "status_query": "blinding_setup_state_snapshot_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity"
      ],
      "notes": "The state_snapshot must capture a cryptographic hash of the randomization list and blinding specification in effect at the time of blind establishment. This provides §11.10(b) 'accurate and complete copy' evidence for regulatory submission and establishes the hash anchor for subsequent database integrity checks during unblinding (trial.unblinding.execute gate).\n"
    },
    "use_case": "Gate establishment of the trial blind behind a verified blinding authority, supervisor review, and a sealed cryptographic snapshot of the randomization list — so the sponsor has a tamper-evident anchor proving the list was fixed before enrolment and unchanged at unblinding time.",
    "industries": [
      "pharma",
      "biotech",
      "cro",
      "medical-device"
    ]
  },
  {
    "id": "ACT-0023",
    "canon_id": "CANON-000020",
    "slug": "trial.unblinding.emergency",
    "display_name": "Emergency Clinical Trial Unblinding",
    "description": "Authorization gate for emergency single-patient unblinding in a clinical trial — the act of breaking the blind for a specific subject when knowledge of their treatment assignment is required for immediate medical decision-making (e.g., a Serious Adverse Event requiring the treating physician to know whether the patient received drug or placebo). Emergency unblinding is per-subject, not a full trial unblinding, and must be performed by the principal investigator or site physician responsible for the subject's safety. REQUESTER-AUTHORIZED: the act is authorized directly by the verified treating physician (the requester) — no approval artifact, approver, or quorum — with requester-bound MFA, a documented medical-necessity attestation, and an immediate audit record. The blind is broken for one subject only — other subjects remain blinded and the trial may continue. Regulatory basis: ICH E6(R2) §4.8.2–3, ICH E9 §6.5, 21 CFR Part 11 §11.300, EU Annex 11 §14.",
    "family": "clinical.trial",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "regulatory",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false,
      "minimum_approvals": 0
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §4.8.2–3 — Breaking the Blind / SAE Reporting",
        "mapping": "Emergency single-subject unblinding is authorized only by the principal investigator or treating physician, with the medical emergency, physician identity, and immediate SAE reporting captured in the signed evaluation.\n",
        "evidence_source": "audit_chain",
        "status_query": "emergency_unblinding_pi_authorized_pct"
      },
      {
        "framework": "ich_e9",
        "clause": "ICH E9 §6.5 — Unblinding at Interim Analysis / Emergency Unblinding Procedures",
        "mapping": "The emergency-unblinding decision is limited to the affected subject and the audit record supports immediate reporting to the sponsor and data monitoring committee.\n",
        "evidence_source": "audit_chain",
        "status_query": "emergency_unblinding_single_subject_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.300 — Controls for Identification Codes and Passwords",
        "mapping": "MFA is enforced for the authorizing physician via requires_mfa; IdP-attested acr/amr claims confirm at least two independent authentication factors.\n",
        "evidence_source": "evaluation_record",
        "status_query": "emergency_unblinding_mfa_enforced_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.50(a)(2) — Signature Manifestations / Approval Meaning",
        "mapping": "The electronic signature includes the subject ID, medical justification, physician role and site, and confirmation that the emergency cannot wait for dual authorization.\n",
        "evidence_source": "audit_chain",
        "status_query": "emergency_unblinding_esignature_meaning_pct"
      },
      {
        "framework": "eu_annex_11",
        "clause": "EU Annex 11 §14 — Audit Trails for Emergency Events",
        "mapping": "The emergency unblinding is captured in the immutable audit trail with actor identity, subject ID, medical justification, timestamp, and SAE reference number.\n",
        "evidence_source": "audit_chain",
        "status_query": "emergency_unblinding_audit_trail_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-04",
      "approval_artifact_required": false,
      "state_snapshot_required": false,
      "required_assertions": [
        "regulatory",
        "identity"
      ],
      "attestation_meaning_template": "\"I authorize emergency unblinding for subject [SUBJECT_ID] in trial [PROTOCOL_NUMBER] as [ROLE] at [SITE]. Medical emergency: [JUSTIFICATION]. I confirm this disclosure is limited to the assigned treatment for this subject only. SAE reference: [SAE_REF]. Date: [DATE].\"\n",
      "notes": "state_snapshot_required is false for emergency unblinding — the treating physician cannot wait for database lock verification in a medical emergency. The sponsor is notified immediately via the audit trail. The sponsor must assess whether trial integrity is compromised if the unblinded physician continues in a role that could bias data collection; this assessment is out-of-scope for AtlaSent.\n"
    },
    "use_case": "Gate emergency single-subject unblinding behind one cryptographically verified treating physician with MFA and a documented medical justification — so a site can act fast in a medical emergency while still producing a signed, offline-verifiable record scoped to the one subject, with the sponsor notified immediately.",
    "industries": [
      "pharma",
      "biotech",
      "cro",
      "hospital-research"
    ]
  },
  {
    "id": "ACT-0024",
    "canon_id": "CANON-000021",
    "slug": "finance.payment.authorize",
    "display_name": "High-Value Payment Authorization",
    "description": "Authorization gate for releasing a payment above an organization's auto-approval threshold — an ACH batch, card settlement, or ERP payment run. High-value payments carry direct financial-loss and fraud exposure, so release must be gated behind two-person integrity with separation of duties: the caller who initiates a payment cannot be the caller who approves it. Every release binds a tamper-evident permit to the amount, counterparty, and account, giving auditors a machine-checkable four-eyes record. Regulatory basis: SOX §404, PCI DSS v4.0, NIST SP 800-53 AC-5.",
    "family": "finance.payment",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls",
        "mapping": "AtlaSent captures a tamper-evident permit for every high-value payment release, proving the dual-authorization control ran with named approvers, amount binding, and audit-chain linkage — the change-control evidence PCAOB AS 2201 expects.\n",
        "evidence_source": "audit_chain",
        "status_query": "payment_dual_auth_pct"
      },
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 7 — Restrict Access by Business Need to Know",
        "mapping": "The permit records that the releasing caller held the payment-release entitlement and that a distinct approver co-signed, enforcing least privilege at release time.\n",
        "evidence_source": "permit_record",
        "status_query": "payment_least_privilege_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "Initiator and approver are required to be distinct principals; the evaluation records both identities, satisfying AC-5 separation-of-duties evidence.\n",
        "evidence_source": "evaluation_record",
        "status_query": "payment_sod_enforced_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "approval"
      ],
      "notes": "The state_snapshot captures the amount, counterparty account, and payment-run hash at authorization time, binding the permit to the specific release for SOX evidence.\n"
    },
    "use_case": "Gate every high-value payment behind two-person integrity with separation of duties and a tamper-evident permit bound to the amount and counterparty — so a controller can prove to an auditor that no single person, and no bot, released funds unauthorized.",
    "industries": [
      "fintech",
      "banking",
      "enterprise",
      "insurance"
    ]
  },
  {
    "id": "ACT-0025",
    "canon_id": "CANON-000022",
    "slug": "finance.wire.transfer",
    "display_name": "High-Value Wire Transfer",
    "description": "Authorization gate for releasing a high-value or cross-border wire (SWIFT / Fedwire). Wires are fast and irreversible, making them the highest-consequence money movement an organization performs and a prime target for business-email-compromise fraud. Release must be gated behind two-person integrity, phishing-resistant MFA for the releasing caller, and a cryptographically verified actor identity — a self-asserted actor_id is not sufficient. The permit binds the beneficiary and amount so the authorization cannot be reused for a different payee. Regulatory basis: SOX §404, SWIFT CSP v2024, NIST SP 800-53 IA-2/AC-5.",
    "family": "finance.payment",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "approval",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Internal Controls Over Financial Reporting",
        "mapping": "Every wire release captures a tamper-evident permit with two named approvers, beneficiary binding, and audit-chain linkage — machine-checkable evidence that the dual-authorization control operated.\n",
        "evidence_source": "audit_chain",
        "status_query": "wire_dual_auth_pct"
      },
      {
        "framework": "swift_csp",
        "clause": "SWIFT CSP v2024 Control 5.1 — Logical Access Control / 2FA",
        "mapping": "Phishing-resistant MFA is enforced for the releasing caller (requires_mfa) and the IdP-attested acr/amr claims are recorded, satisfying SWIFT CSP two-factor and access control expectations for the payment operator.\n",
        "evidence_source": "evaluation_record",
        "status_query": "wire_mfa_enforced_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 IA-2 — Identification and Authentication",
        "mapping": "The releasing caller's identity is cryptographically verified (requires_verified_actor) rather than self-asserted, binding the wire authorization to an attested principal.\n",
        "evidence_source": "evaluation_record",
        "status_query": "wire_verified_actor_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-04",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "approval",
        "identity"
      ],
      "notes": "The state_snapshot binds the beneficiary account, amount, and currency at authorization time. Callback-verified beneficiary details should be captured in context so the permit evidences that payee verification occurred before release.\n"
    },
    "use_case": "Gate high-value and cross-border wires behind two-person integrity, phishing-resistant MFA, and a verified actor, with the beneficiary bound into the permit — so treasury can prove no single person, no unverified identity, and no bot released an irreversible wire.",
    "industries": [
      "banking",
      "fintech",
      "enterprise",
      "insurance"
    ]
  },
  {
    "id": "ACT-0026",
    "canon_id": "CANON-000023",
    "slug": "industrial.control.actuate",
    "display_name": "Industrial Control Actuation",
    "description": "Authorization gate for a consequential command to a physical-process controller — a breaker or switch operation on a power grid, a valve or pump actuation on a pipeline, or a control setpoint change on a DCS/PLC. These commands have direct physical, safety, and reliability consequences, so they are gated at an OT control gateway that sits between the operator's HMI and the field device, outside the real-time safety loop. Release requires two-person integrity, phishing-resistant MFA, and a state snapshot of the command and target device tag. An unverified or automated caller never reaches the actuator. Regulatory basis: NERC CIP-004/007/010, IEC 62443-3-3 SR 1.1/2.1.",
    "family": "industrial.control",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "approval",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "nerc_cip",
        "clause": "NERC CIP-010-4 — Configuration Change Management",
        "mapping": "Every control-actuation command captures a tamper-evident permit binding the device tag, command, and old→new value, with named authorizers — the change-authorization evidence CIP-010 requires for BES cyber systems.\n",
        "evidence_source": "audit_chain",
        "status_query": "ot_actuation_change_auth_pct"
      },
      {
        "framework": "nerc_cip",
        "clause": "NERC CIP-004-6 — Personnel & Training / Access Management",
        "mapping": "The actuating caller's identity is cryptographically verified and MFA-attested, evidencing that only authorized, trained personnel issued the command.\n",
        "evidence_source": "evaluation_record",
        "status_query": "ot_actuation_verified_operator_pct"
      },
      {
        "framework": "iec_62443",
        "clause": "IEC 62443-3-3 SR 2.1 — Authorization Enforcement",
        "mapping": "Authorization is enforced at the control gateway before the command is relayed to the field device, with two-person integrity for consequential actuation (SR 2.1 / SR 1.1).\n",
        "evidence_source": "permit_record",
        "status_query": "ot_actuation_gateway_enforced_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "approval",
        "identity"
      ],
      "notes": "The state_snapshot binds the device tag, the command, and the old→new setpoint or state at authorization time. Evidence is reconcilable against the historian to detect command-versus-observed drift.\n"
    },
    "use_case": "Gate consequential OT control commands — breaker operations, valve actuations, setpoint changes — behind two-person integrity, MFA, and a verified operator at a control gateway, so a utility or operator can prove every physical command was authorized by named, trained personnel with a signed, offline-verifiable record.",
    "industries": [
      "energy",
      "utilities",
      "oil-and-gas",
      "manufacturing",
      "water"
    ]
  },
  {
    "id": "ACT-0027",
    "canon_id": "CANON-000024",
    "slug": "healthcare.record.amend",
    "display_name": "Patient Health Record Amendment",
    "description": "Authorization gate for amending a finalized (signed) patient health record in an EHR — an addendum or correction to a closed encounter note. A finalized clinical record is a legal document; amending it must preserve the original, attribute the change to a verified clinician with a treatment relationship, and capture the reason. The gate requires a cryptographically verified actor (a self-asserted actor_id from a hospital system is not sufficient), human approval, and a state snapshot that preserves the pre-amendment record. Regulatory basis: HIPAA Security Rule §164.312, 21 CFR Part 11 §11.10(e), ISO 27799.",
    "family": "healthcare.record",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "hipaa",
        "clause": "HIPAA Security Rule §164.312(c)(1) — Integrity",
        "mapping": "The permit binds a state snapshot of the pre-amendment record and the verified identity of the amending clinician, evidencing the integrity controls HIPAA requires for electronic protected health information.\n",
        "evidence_source": "audit_chain",
        "status_query": "ehr_amendment_integrity_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(e) — Audit Trails",
        "mapping": "The reason for the amendment is captured with the clinician's verified identity and a timestamp in the signed audit event; the original record is preserved.\n",
        "evidence_source": "audit_chain",
        "status_query": "ehr_amendment_reason_capture_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.15 — Logging",
        "mapping": "Every amendment writes an immutable, attributable audit-chain entry, satisfying the logging and accountability controls for a clinical system of record.\n",
        "evidence_source": "audit_chain",
        "status_query": "ehr_amendment_audit_coverage_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity"
      ],
      "notes": "The state_snapshot captures a hash of the pre-amendment record so the original is preserved and the amendment is bound to the exact prior state (HIPAA integrity).\n"
    },
    "use_case": "Gate amendments to finalized patient records behind a cryptographically verified clinician, human approval, and a snapshot that preserves the original — so a provider can prove to an auditor or regulator that every change to a legal health record was attributable, reasoned, and integrity-preserving.",
    "industries": [
      "healthtech",
      "hospital-systems",
      "payers",
      "life-sciences"
    ]
  },
  {
    "id": "ACT-0028",
    "canon_id": "CANON-000025",
    "slug": "identity.privileged.grant",
    "display_name": "Privileged Access Grant",
    "description": "Authorization gate for granting privileged or administrative access — writing an elevated entitlement into an IdP, PAM vault, or directory. Privileged access can dissolve every other control, so the grant itself is a governed action: it requires human approval, phishing-resistant MFA for the approver, and a cryptographically verified actor. The grant is time-boxed via the permit so it can auto-revert on expiry. Regulatory basis: NIST SP 800-53 AC-6, ISO/IEC 27001 A.8.2, SOC 2 CC6.1.",
    "family": "identity.access",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-6 — Least Privilege",
        "mapping": "Each privileged grant captures a tamper-evident permit with a named approver, the grantee, the entitlement scope, and a TTL — evidence that least-privilege and access approval controls operated at grant time.\n",
        "evidence_source": "audit_chain",
        "status_query": "privileged_grant_approval_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.2 — Privileged Access Rights",
        "mapping": "The permit records approval and MFA for every privileged-access allocation, satisfying the restricted, controlled-allocation requirement for privileged rights.\n",
        "evidence_source": "permit_record",
        "status_query": "privileged_grant_mfa_pct"
      },
      {
        "framework": "soc2",
        "clause": "SOC 2 CC6.1 — Logical Access Controls",
        "mapping": "The verified identity of the approver and grantee is recorded, evidencing the logical access provisioning control the Trust Services Criteria expect.\n",
        "evidence_source": "evaluation_record",
        "status_query": "privileged_grant_verified_actor_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-04",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "identity",
        "approval"
      ],
      "notes": "The permit carries the grantee, entitlement scope, and TTL. On expiry the auto-revert record closes the loop, so the access grant is bounded and evidenced end to end.\n"
    },
    "use_case": "Make privileged access itself a governed action — every admin grant requires human approval, phishing-resistant MFA, and a verified approver, with a time-boxed permit that auto-reverts. A security team can prove exactly who granted what elevated access, to whom, for how long, and with what approval.",
    "industries": [
      "saas",
      "fintech",
      "enterprise",
      "healthtech",
      "government"
    ]
  },
  {
    "id": "ACT-0029",
    "canon_id": "CANON-000026",
    "slug": "agent.tool.invoke",
    "display_name": "Agent Tool Invocation",
    "description": "Authorization gate for an autonomous AI agent invoking a tool, function, or downstream action at execution time. The agent's asserted identity is not trusted on its own — a self-declared actor_id can be spoofed — so the request must carry a cryptographically verified actor identity before the tool runs. This is the flagship execution-time authorization surface: every agent action is gated, permitted, and audited before it touches a real system.",
    "family": "agent.execute",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "identity",
        "risk"
      ]
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "eu_ai_act",
        "clause": "EU AI Act Art. 14(4)(d)-(e) — Human Oversight (partial)",
        "mapping": "Partial, technical contribution only. A tool invocation cannot execute without a verified permit, so the runtime can refuse it (Art. 14(4)(d)) and the pre-call gate acts as the \"stop\" procedure for each discrete invocation (Art. 14(4)(e)). This action does not require human approval by default; routing specific invocations to a human decision needs a deployer-configured hold/escalate policy. It does not cover Art. 14(1)-(2) or 14(4)(a)-(c), and whether an agent is a high-risk system in scope of Art. 14 at all is the deployer's determination. The audit chain records what the agent did and the authority under which it acted.\n",
        "evidence_source": "audit_chain",
        "status_query": "agent_action_permit_coverage"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-3 — Access Enforcement",
        "mapping": "AtlaSent enforces access decisions at the point of tool execution rather than trusting the agent runtime to self-police.\n",
        "evidence_source": "permit_record",
        "status_query": "ac3_agent_enforcement_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": false,
      "required_assertions": [
        "identity",
        "risk"
      ],
      "notes": "The verified actor identity assertion and a contemporaneous risk assertion are bound into the permit so the audit record proves which agent acted and at what risk level.\n"
    },
    "use_case": "Gate every autonomous agent tool call behind a verifiable permit so you can prove which agent did what, under what verified identity, and at what risk — the enforcement layer AI agent frameworks lack.",
    "industries": [
      "saas",
      "fintech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0030",
    "canon_id": "CANON-000027",
    "slug": "model.promote",
    "display_name": "Model Promotion",
    "description": "Authorization gate for promoting an AI/ML model to a production-serving environment. Promoting a model is a consequential transition: an unvetted or tampered model can make autonomous decisions at scale. Promotion requires human approval, a verified actor, a bound snapshot of the exact model artifact, and a model-trust assertion establishing the base model and evaluation provenance before a permit is issued.",
    "family": "agent.execute",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "model_trust",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "eu_ai_act",
        "clause": "EU AI Act Art. 9 — Risk Management System",
        "mapping": "Model promotion permits capture the human sign-off, model provenance, and evaluation evidence required before a high-risk AI system is placed into service.\n",
        "evidence_source": "audit_chain",
        "status_query": "model_promotion_control_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "Promotion is treated as a controlled change with a documented, verifiable authorization record binding the approver to the exact model artifact.\n",
        "evidence_source": "permit_record",
        "status_query": "model_change_control_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "model_trust",
        "identity"
      ],
      "notes": "State snapshot captures the model artifact digest and evaluation report hash, binding the permit to the exact model promoted.\n"
    },
    "use_case": "Gate every model promotion behind human approval, a bound model snapshot, and a model-trust assertion so you can prove which model reached production and who authorized it.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0031",
    "canon_id": "CANON-000028",
    "slug": "data.export",
    "display_name": "Bulk Data Export",
    "description": "Authorization gate for exporting a bulk dataset out of a system of record — a data-egress transition with high privacy and compliance blast radius. A large export of personal data can breach residency obligations or consent scope. Export requires human approval and verified residency and consent assertions before a permit is issued, and direct-identifier fields are denied unless explicitly permitted.",
    "family": "data.release",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "residency",
        "consent"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 20 — Right to Data Portability / Art. 44 — Transfers",
        "mapping": "Export permits capture the lawful basis, residency scope, and human authorization for a data egress, providing the accountability record GDPR requires for transfers.\n",
        "evidence_source": "audit_chain",
        "status_query": "data_export_control_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA Security Rule §164.312(b) — Audit Controls",
        "mapping": "Bulk exports of records are gated and recorded with a tamper-evident permit naming the authorizer and the residency/consent scope.\n",
        "evidence_source": "permit_record",
        "status_query": "phi_export_permit_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "residency",
        "consent"
      ],
      "notes": "The residency and consent assertions are bound into the permit so the audit record proves the export stayed within its lawful scope.\n"
    },
    "use_case": "Gate every bulk data export behind human approval and verified residency/consent scope so you can prove no dataset left the boundary without authorization and lawful basis.",
    "industries": [
      "fintech",
      "healthtech",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0032",
    "canon_id": "CANON-000029",
    "slug": "security.breakglass",
    "display_name": "Break-Glass Access",
    "description": "Authorization gate for emergency break-glass access — an intentional, time-bounded exception that grants elevated privilege during an incident. Break-glass is the most abused path in any system, so it is the most heavily gated: it requires a verified human actor, multi-factor authentication, an explicit approval artifact, and a bound snapshot of the incident context. A machine can never invoke it. Every use produces a tamper-evident permit for post-incident review.",
    "family": "security.exception",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity",
        "risk"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls",
        "mapping": "Break-glass permits provide the documented, named, time-bounded record of every emergency privilege escalation that SOX change-control review depends on.\n",
        "evidence_source": "audit_chain",
        "status_query": "breakglass_control_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-6(9) — Auditing Use of Privileged Functions",
        "mapping": "Every privileged break-glass invocation is captured with a verifiable permit naming the verified human actor and the incident context.\n",
        "evidence_source": "permit_record",
        "status_query": "privileged_use_audit_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity",
        "risk"
      ],
      "notes": "State snapshot captures the incident id and the scope of elevated privilege, binding the permit to the specific emergency it was granted for.\n"
    },
    "use_case": "Gate every break-glass escalation behind verified identity, MFA, and human approval so each emergency privilege grant is attributable, time-bounded, and provable in post-incident review.",
    "industries": [
      "fintech",
      "healthtech",
      "saas",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0033",
    "canon_id": "CANON-000030",
    "slug": "release.create",
    "display_name": "Release Creation",
    "description": "Authorization gate for creating an identified, releasable production version — assembling an approved set of changes into a versioned, reproducible release artifact. Release creation is the point where a set of merged changes becomes a candidate for deployment; an unidentified or unapproved release undermines every downstream deploy and audit. State snapshot binding captures the release's content identity (git SHA range, artifact digest, changelog hash) so the permit is bound to exactly what was released.",
    "family": "production.deploy",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "AtlaSent records every release creation with actor identity and the release's content identity, providing the documented authorization ISO 27001 requires before a change set is promoted toward production.\n",
        "evidence_source": "audit_chain",
        "status_query": "release_creation_documented_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
        "mapping": "Release creation is a controlled configuration event; the permit captures the identified baseline that CM-3 requires be established before deployment.\n",
        "evidence_source": "permit_record",
        "status_query": "release_baseline_permit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the release's content identity — the commit range, the built artifact digest(s), and a hash of the generated changelog — so the release is reproducible and the permit is bound to it.\n"
    },
    "use_case": "Bind every production release to a tamper-evident permit capturing exactly what was released — commit range, artifact digest, changelog — so a deploy can only proceed from an identified, authorized release, and auditors can reconstruct any release's content.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0034",
    "canon_id": "CANON-000031",
    "slug": "production.rollback",
    "display_name": "Production Rollback",
    "description": "Authorization gate for rolling back a production deployment to a prior version. A rollback is itself a production change — it can restore a version with a known vulnerability, revert a data-affecting migration, or mask an unresolved incident — and must be governed, not treated as an exempt safety valve. State snapshot binding captures the current and target versions so the permit records exactly what state the system was moved to.",
    "family": "production.deploy",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "A rollback is a change to production. AtlaSent records it with actor identity and the from/to versions, providing the same documented authorization ISO 27001 requires for any production change.\n",
        "evidence_source": "audit_chain",
        "status_query": "rollback_documented_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
        "mapping": "Rollbacks are configuration changes under CM-3; the permit captures the authorized target baseline the system was reverted to.\n",
        "evidence_source": "permit_record",
        "status_query": "rollback_target_permit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the version being rolled back FROM and the version rolled back TO (image digests or release ids), plus the triggering reason. This makes a rollback that restores a vulnerable version auditable after the fact.\n"
    },
    "use_case": "Govern rollbacks like the production changes they are — a signed permit recording who rolled back what, from which version to which, and why — so a rollback that restores a vulnerable build or reverts a migration is never an untracked event.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0035",
    "canon_id": "CANON-000032",
    "slug": "database.migrate",
    "display_name": "Database Migration",
    "description": "Authorization gate for executing a schema or data migration against a production database. Migrations are among the hardest-to-reverse production changes — a bad migration can corrupt or drop data, lock tables, or leave the schema in an inconsistent state — and carry strong change-control and record-integrity evidence demands under SOX and GxP. Human approval plus a state snapshot binding the migration's content hash gate the action to a reviewed, identified migration.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls",
        "mapping": "Migrations to systems processing financial data are change-management events. AtlaSent captures a permit with named approver, the migration's content hash, and timestamp — satisfying PCAOB AS 2201 change-control evidence for database changes.\n",
        "evidence_source": "audit_chain",
        "status_query": "db_migration_change_control_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "A migration permit is the documented authorization ISO 27001 requires before a change alters production data structures.\n",
        "evidence_source": "permit_record",
        "status_query": "db_migration_permit_coverage"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
        "mapping": "Database migrations are controlled configuration changes; AtlaSent enforces the approval and documentation of CM-3 at execution time.\n",
        "evidence_source": "audit_chain",
        "status_query": "cm3_db_migration_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture a hash of the migration content (the DDL/DML or migration file digest) and the target database identity, binding the permit to exactly what was migrated. Approval artifact records the reviewing DBA/owner.\n"
    },
    "use_case": "Gate every production database migration behind an approved, content-bound permit — proving the migration that ran is the migration a qualified owner reviewed, with an offline-verifiable record for SOX and GxP change-control evidence.",
    "industries": [
      "fintech",
      "healthtech",
      "saas",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0036",
    "canon_id": "CANON-000033",
    "slug": "infrastructure.change",
    "display_name": "Infrastructure Change",
    "description": "Authorization gate for changing production infrastructure or its configuration — applying Terraform/Helm, altering gateway routing, changing network controls (WAF rules, security groups, ingress, DNS, load balancers), and changing monitoring/alerting configuration (alert routing and thresholds, silences/mutes, health checks, on-call escalation policies, dashboards and retention windows that feed incident response). Infrastructure changes carry broad blast radius: a routing or firewall change can expose or sever production traffic across all services, and a monitoring-configuration change can blind the organization to the consequences of that same failure. Human approval plus a state snapshot binding the planned change (plan hash) gate the action to a reviewed, identified change. Production network-control and monitoring-configuration changes are governed under this action as scenarios of infrastructure change, not as separate actions.\nMonitoring-configuration scope (governed scenario, not a separate action): a change that SUPPRESSES, DISABLES, or MATERIALLY WEAKENS a monitoring or alerting capability — muting or snoozing an alert, raising an alert threshold, disabling a health check, removing a service from a paging rotation or dashboard, or shortening a retention window that would hide the change later — is a \"cover your tracks\" risk pattern: it reduces the organization's ability to detect the consequences of the very change (or a related change) it accompanies. This scenario ALWAYS requires human approval, REGARDLESS of whether the organization has otherwise configured infrastructure.change to allow change-window-based or other lower-friction handling for routine infrastructure changes. No org-level relaxation of this action's friction may ever exempt a monitoring-weakening change, even one that would otherwise qualify as \"routine\" and route through a low-friction path.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "AtlaSent records every production infrastructure change with actor identity, approver, and the planned change identity — the documented authorization ISO 27001 requires before infrastructure is altered.\n",
        "evidence_source": "audit_chain",
        "status_query": "infra_change_control_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CM-3 — Configuration Change Control",
        "mapping": "Infrastructure and network-control changes are controlled configuration events; AtlaSent enforces CM-3 approval and documentation at apply time.\n",
        "evidence_source": "permit_record",
        "status_query": "cm3_infra_change_pct"
      },
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 1 — Install and Maintain Network Security Controls",
        "mapping": "Changes to firewalls, security groups, and ingress are network-security-control changes. The permit provides the authorized, documented record PCI DSS requires for network-control modifications.\n",
        "evidence_source": "audit_chain",
        "status_query": "network_control_change_permit_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 SI-4 — System Monitoring",
        "mapping": "A change that suppresses, disables, or materially weakens monitoring or alerting is itself a controlled event under this action, and is always human-approved — the permit is evidence that a reduction in detection capability was reviewed rather than made unilaterally at execution time.\n",
        "evidence_source": "audit_chain",
        "status_query": "monitoring_config_change_approval_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the plan identity — a Terraform plan hash, Helm release digest, or a hash of the network-control rule diff — binding the permit to exactly what was applied. Approval artifact records the reviewer.\n"
    },
    "use_case": "Gate every production infrastructure and network-control change behind an approved, plan-bound permit — proving the change that applied is the change that was reviewed, with an offline-verifiable record for change-management and PCI network-control evidence.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0037",
    "canon_id": "CANON-000034",
    "slug": "feature.enable",
    "display_name": "Feature Enablement",
    "description": "Authorization gate for enabling a high-impact feature flag in production. A feature flag flip is a de-facto production change — it can expose an unfinished feature, change data-handling behavior, or shift load — without going through a deploy. This action gates the enablement of flags marked high-impact to an authorized role, so a flag flip carries the same accountability as a deploy while staying a lightweight, standard-risk operation.",
    "family": "production.deploy",
    "risk_posture": "standard",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.32 — Change Management",
        "mapping": "Enabling a high-impact feature flag is a production change. AtlaSent records it with actor identity and the flag identity — the documented authorization ISO 27001 expects for behavior-changing production events.\n",
        "evidence_source": "audit_chain",
        "status_query": "feature_enable_documented_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": false,
      "state_snapshot_required": false,
      "notes": "The evaluate context should carry the flag key and the target environment, so every high-impact enablement is attributable to an actor and a flag. Low-impact flags need not be routed through this gate — reserve it for flags marked high-impact.\n"
    },
    "use_case": "Make every high-impact feature flip in production attributable — a signed record of who enabled which flag, when — so a flag change that alters behavior or exposes an unfinished feature is never an anonymous, untracked event.",
    "industries": [
      "saas",
      "fintech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0038",
    "canon_id": "CANON-000035",
    "slug": "secret.rotate",
    "display_name": "Secret Rotation",
    "description": "Authorization gate for rotating a production credential or signing key — API keys, database passwords, service tokens, or signing material. Rotation is a privileged operation: a botched or malicious rotation can cause a widespread outage (every consumer of the old secret breaks) or, worse, hand an attacker fresh valid credentials. State snapshot binding captures the secret identity and key version so the permit records exactly which secret was rotated to which version.\nScope: this action governs rotating a secret's VALUE only — producing a new credential/key version for an existing secret. It does NOT cover changing a secret's ACCESS-CONTROL or GOVERNANCE configuration (who or what may read it, where it is stored, its rotation policy or schedule) — that is a materially broader, higher-authority access-control decision governed by secret.configuration.change (CANON-000054), which requires human approval and a verified, MFA'd approver. A caller widening who can read a secret, or relocating/reconfiguring its storage or rotation policy, must call secret.configuration.change, not this action. trust_root.publish (CANON-000035) remains a value-rotation-shaped specialization of THIS action; secret.configuration.change is a distinct standalone canonical action, not a specialization of secret.rotate.",
    "family": "privileged.operation",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.17 — Authentication Information",
        "mapping": "AtlaSent records every production secret rotation with actor identity and the secret/key version — the documented control ISO 27001 expects over authentication information and its lifecycle.\n",
        "evidence_source": "audit_chain",
        "status_query": "secret_rotation_documented_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 IA-5 — Authenticator Management",
        "mapping": "Rotation is an authenticator-management event; the permit captures the authorized actor and the rotated secret's identity, evidencing IA-5 lifecycle control.\n",
        "evidence_source": "permit_record",
        "status_query": "ia5_rotation_permit_pct"
      },
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 3 — Protect Stored Account Data (key management)",
        "mapping": "Cryptographic key rotation is a PCI key-management event. AtlaSent provides the authorized, documented record PCI requires for key-lifecycle operations.\n",
        "evidence_source": "audit_chain",
        "status_query": "key_rotation_permit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the secret identity (name/ARN, not the value) and the resulting key version or fingerprint. Never place the secret value in the context — only its identity and version.\n"
    },
    "use_case": "Gate every production secret and signing-key rotation behind a permit that records who rotated which secret to which version — so a rotation that breaks production or provisions attacker-controlled credentials is never an untracked event, with offline-verifiable evidence for key-management compliance.",
    "industries": [
      "fintech",
      "saas",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0039",
    "canon_id": "CANON-000036",
    "slug": "traffic.failover",
    "display_name": "Traffic Failover",
    "description": "Authorization gate for failing over production traffic — transferring live traffic to a standby region, cluster, or provider to preserve availability. A failover is a first-class operational action with its own intent (preserve availability), evidence, and risk profile: it can move traffic to an under-capacity or stale standby, split-brain a stateful system, or mask a regional dependency failure. State snapshot binding captures the pre-failover topology and the failover target so the permit records exactly where traffic was moved.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.14 — Redundancy of Information Processing Facilities",
        "mapping": "AtlaSent documents every deliberate traffic failover with actor identity and the source/ target topology — evidencing the availability-management controls ISO 27001 expects over redundant processing facilities.\n",
        "evidence_source": "audit_chain",
        "status_query": "failover_documented_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 CP-10 — System Recovery and Reconstitution",
        "mapping": "Failover is a recovery/continuity action; the permit captures the authorized actor and the target the system was failed over to, evidencing CP-10 continuity operations.\n",
        "evidence_source": "permit_record",
        "status_query": "cp10_failover_permit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the source and target (region/cluster/provider), the triggering reason, and the standby's readiness signal at failover time — so a failover to a stale or under-capacity standby is auditable after the fact.\n"
    },
    "use_case": "Govern traffic failover as the first-class operational action it is — a signed permit recording who failed over what, from where to where, and why — so a failover to a stale or under-capacity standby is never an untracked event, with offline-verifiable continuity evidence.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0040",
    "canon_id": "CANON-000037",
    "slug": "host.isolate",
    "display_name": "Host Isolation",
    "description": "Authorization gate for network-isolating a compromised host or endpoint as an incident containment action — cutting a machine off from the network (EDR quarantine, security-group lockdown, NAC quarantine) to stop lateral movement or exfiltration while preserving it for forensics. Host isolation is a distinct operational action: unlike a generic infrastructure change it is taken under incident pressure by a reliability or security responder, targets a single host, and its evidence is the containment record — who isolated what, when, and why. State snapshot binding captures the host state at isolation time for the forensic timeline.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 IR-4 — Incident Handling",
        "mapping": "AtlaSent records every host isolation with a verified responder identity, the target host, and the containment reason — the documented, attributable containment action IR-4 requires during incident response.\n",
        "evidence_source": "audit_chain",
        "status_query": "host_isolation_documented_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.26 — Response to Information Security Incidents",
        "mapping": "The isolation permit is the evidence ISO 27001 expects that a containment action was authorized and attributable when it was taken.\n",
        "evidence_source": "permit_record",
        "status_query": "containment_permit_coverage"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the host identifier, its network state at isolation time (active connections, VLAN/security-group), and the triggering reason or detection — so the containment and its justification are auditable in the incident timeline.\n"
    },
    "use_case": "Gate every host isolation behind a permit that records a verified responder, the target host, and the reason — so a containment action taken under incident pressure is attributable and offline-verifiable, and an attacker or compromised automation cannot quietly isolate (or fail to isolate) hosts without a trace.",
    "industries": [
      "saas",
      "fintech",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0041",
    "canon_id": "CANON-000038",
    "slug": "protocol.amend",
    "display_name": "Clinical Protocol Amendment",
    "description": "Authorization gate for amending the protocol of an active clinical trial — a regulated governance event, not a workflow step. A protocol amendment changes the governing document of a trial and cannot take effect without IRB/EC approval, sponsor authorization, and, for substantial amendments, regulatory notification or approval. It carries distinct authorization (independent, credentialed sign-off) and distinct evidence (the amendment, the approvals, the version) from any routine change. State snapshot binding captures the amendment's content and version so the permit is bound to exactly what was approved.",
    "family": "clinical.trial",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "regulatory"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §4.5 — Compliance with Protocol / §3.3 (IRB/IEC)",
        "mapping": "A protocol amendment requires documented IRB/EC approval before implementation. AtlaSent binds the amendment permit to the approval and the amended version — the authorized, attributable record GCP requires that the change was sanctioned before it took effect.\n",
        "evidence_source": "audit_chain",
        "status_query": "protocol_amendment_approval_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR 312.30 — IND Protocol Amendments",
        "mapping": "Substantial protocol changes require submission to the IND. The permit captures the sponsor authorization and the amendment identity, evidencing the controlled amendment process 21 CFR 312.30 requires.\n",
        "evidence_source": "permit_record",
        "status_query": "ind_protocol_amendment_pct"
      },
      {
        "framework": "eu_annex_11",
        "clause": "EU Annex 11 §1 (Risk Management) / Clinical Trials Regulation substantial modifications",
        "mapping": "A substantial modification to a trial protocol is a controlled, authorized change. AtlaSent provides the documented authorization and version binding expected for it.\n",
        "evidence_source": "audit_chain",
        "status_query": "substantial_modification_permit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "regulatory"
      ],
      "notes": "The state snapshot should capture the amendment content hash and the new protocol version; the approval artifact records the authorizing sponsor/regulatory role; the regulatory assertion attests that IRB/EC approval (and, for substantial amendments, regulatory notification) is on file.\n"
    },
    "use_case": "Gate every clinical protocol amendment behind an approved, version-bound permit with a regulatory assertion — proving the amendment that took effect is the amendment a sponsor and IRB/EC approved, with an offline-verifiable record for GCP inspection readiness.",
    "industries": [
      "healthtech",
      "regulated-industries",
      "enterprise"
    ]
  },
  {
    "id": "ACT-0042",
    "canon_id": "CANON-000039",
    "slug": "employment.terminate",
    "display_name": "Employment Termination",
    "description": "Authorization gate for terminating the employment relationship of a worker — the consequential employment-status decision, not the downstream technical deprovision. Ending employment carries distinct legal, final-pay, benefits, and works-council consequences that access.revoke (CANON-000008) does not: access revocation is the required EFFECT of a termination, while the decision to end the relationship is its CAUSE. Independent, credentialed sign-off (manager + HR business partner / employment counsel) and a verified actor gate the action to a reviewed, attributable authority, with a captured reason for the record.",
    "family": "people.operations",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 PS-4 — Personnel Termination",
        "mapping": "PS-4 requires that, upon termination, access is disabled and the action is documented and attributable. AtlaSent binds the termination decision to a named authorizing role and a verified actor before the deprovision runs — the authorized, evidenced record PS-4 expects.\n",
        "evidence_source": "audit_chain",
        "status_query": "employment_termination_authorization_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.6.5 — Responsibilities after termination or change of employment",
        "mapping": "A termination must be a controlled, authorized event with responsibilities discharged. AtlaSent supplies the documented authorization and the offline-verifiable record that the employment change was sanctioned by an appropriate authority.\n",
        "evidence_source": "permit_record",
        "status_query": "termination_controlled_change_pct"
      },
      {
        "framework": "sox",
        "clause": "SOX §404 — segregation of duties over the employment/payroll decision",
        "mapping": "For roles with financial-reporting responsibility, ending employment is a controlled change with a payroll consequence. AtlaSent enforces independent approval (requester != sole authority) at execution time, evidencing the segregation of duties §404 expects.\n",
        "evidence_source": "audit_chain",
        "status_query": "termination_sod_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The approval artifact records the co-approving HR/legal authority; the verified actor binds the decision to a real individual; a captured reason (§ reason-for-change) is folded into the signed audit event. Retention follows the employment-record regime (often years post-termination), above the 90-day permit floor.\n"
    },
    "use_case": "Gate every employment termination behind an independently-approved, verified permit — proving the decision to end an employment relationship was authorized by a real HR/legal authority, with an offline-verifiable record for an employment tribunal, works council, or SOX reviewer.",
    "industries": [
      "enterprise",
      "saas",
      "fintech",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0043",
    "canon_id": "CANON-000040",
    "slug": "compensation.change",
    "display_name": "Compensation Change",
    "description": "Authorization gate for changing an employee's compensation — a SOX-controlled financial event with an approval chain and a downstream payroll disbursement consequence, distinct from a generic data.modify (CANON-000004) record edit. A compensation change alters a recurring financial obligation and is a recognized fraud and control surface. Independent approval (the requesting manager is not the sole authority) and a verified actor gate the action to a reviewed, attributable decision.",
    "family": "people.operations",
    "risk_posture": "high",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls (payroll / compensation)",
        "mapping": "A compensation change is a change to a recurring financial obligation. AtlaSent captures a permit with the independent approver, the verified actor, and timestamp — the ICFR evidence §404 expects for payroll-affecting changes.\n",
        "evidence_source": "audit_chain",
        "status_query": "compensation_change_control_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "The requester of a compensation change cannot be its sole approver. AtlaSent enforces the separation of duties AC-5 requires at execution time, with an attributable record.\n",
        "evidence_source": "permit_record",
        "status_query": "compensation_sod_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
        "mapping": "Conflicting duties over a financial change are separated. AtlaSent provides the documented, independent authorization ISO 27001 expects before a compensation change takes effect.\n",
        "evidence_source": "audit_chain",
        "status_query": "compensation_segregation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The approval artifact records the independent compensation/HR approver; the verified actor binds the change to a real individual. Retention follows the payroll/financial-record regime (commonly multi-year), above the 90-day permit floor.\n"
    },
    "use_case": "Gate every compensation change behind an independently-approved, verified permit — proving each pay change was authorized by a real, separate authority, with an offline-verifiable record for a SOX payroll-controls review.",
    "industries": [
      "enterprise",
      "fintech",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0044",
    "canon_id": "CANON-000041",
    "slug": "journal.post",
    "display_name": "Journal Entry Posting",
    "description": "Authorization gate for posting a journal entry to the general ledger — a COMMIT of an immutable financial record, distinct from a data.modify (CANON-000004) value edit. A posted journal entry cannot be edited, only reversed by a new entry, and carries its own preparer/poster segregation of duties and SOX ICFR evidence demand. Independent approval (the preparer is not the poster) and a state snapshot binding the entry's content hash gate the action to a reviewed, identified posting, so the entry that lands in the ledger is the entry that was approved.",
    "family": "finance.controllership",
    "risk_posture": "high",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls (manual journal entries)",
        "mapping": "Manual journal entries are a primary ICFR control point. AtlaSent captures a permit with the independent poster, the entry's content hash, and timestamp — the preparer/poster segregation-of-duties evidence §404 and PCAOB AS 2201 expect for GL postings.\n",
        "evidence_source": "audit_chain",
        "status_query": "journal_entry_control_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "The preparer of a journal entry cannot be its poster. AtlaSent enforces the separation of duties AC-5 requires at execution time, bound to the entry content.\n",
        "evidence_source": "permit_record",
        "status_query": "journal_sod_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
        "mapping": "Conflicting duties over a committed financial record are separated. AtlaSent provides the documented, independent authorization and the content-bound permit ISO 27001 expects.\n",
        "evidence_source": "audit_chain",
        "status_query": "journal_segregation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture a hash of the journal-entry body (lines, accounts, amounts) and the ledger/period identity, binding the permit to exactly what posted. The approval artifact records the independent poster. Retention follows the SOX financial-record regime (commonly 7 years), above the 90-day permit floor.\n"
    },
    "use_case": "Gate every manual journal-entry posting behind an independently-approved, content-bound permit — proving the entry that committed to the ledger is the entry a separate authority approved, with an offline-verifiable record for a SOX ICFR review.",
    "industries": [
      "fintech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0045",
    "canon_id": "CANON-000042",
    "slug": "period.close",
    "display_name": "Accounting Period Close",
    "description": "Authorization gate for closing (locking) an accounting period — the state-changing COMMIT that freezes the general ledger for a fiscal period so no further entries post to it. This is an EXECUTION action, distinct from the attestations it consumes: reconciliation certification (compliance.certify) and journal-entry approval (workflow.approve) prove READINESS, but closing the period is the separately-authorized, separately-recorded operational act that has its own consequence. Merging it into the certification would collapse \"the reconciliations are certified and approvals exist\" into \"the period is closed\" — two different points in the control chain. The close cannot reach allow unless all reconciliations are certified and dual approval is on file, and it binds a state snapshot of the period's closing state, so the period that locks is the period whose readiness was authorized.",
    "family": "finance.controllership",
    "risk_posture": "high",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": true,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls (period-end financial reporting)",
        "mapping": "The period-end close is a primary ICFR control point. AtlaSent captures a permit binding the dual authorization, the certified-reconciliation state, and the period identity — evidence that the close was executed only after readiness was independently certified, distinct from the certification itself, as §404 and PCAOB AS 2201 expect for the period-end close process.\n",
        "evidence_source": "audit_chain",
        "status_query": "period_close_control_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "The authority that certifies a period ready is separated from the authority that executes the close. AtlaSent enforces at execution time that closing the period is a distinct, dual-approved act, not an automatic consequence of certification.\n",
        "evidence_source": "permit_record",
        "status_query": "period_close_sod_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
        "mapping": "Certifying readiness and executing the consequential close are separated. AtlaSent provides the documented, independent authorization and the period-bound permit ISO 27001 expects for a state-changing financial operation.\n",
        "evidence_source": "audit_chain",
        "status_query": "period_close_segregation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "notes": "The state snapshot should capture the period identity and the readiness state it consumes — that all reconciliations were certified and dual approval was on file at the moment of close — binding the permit to exactly the period and state that locked. The approval artifact records the independent close authorization. Retention follows the SOX financial-record regime (commonly 7 years), above the 90-day permit floor.\n"
    },
    "use_case": "Gate every accounting-period close behind a dual-authorized, readiness-bound permit — proving the period that locked was closed by a separate authority only after its reconciliations were certified and approvals were on file, with an offline-verifiable record that a SOX ICFR review can test the close control on independently of the certifications it consumes.",
    "industries": [
      "fintech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0046",
    "canon_id": "CANON-000043",
    "slug": "trial.biomarker.reclassify",
    "display_name": "Biomarker Result Reclassification Approval",
    "description": "Authorization gate for approving and releasing a corrected or reinterpreted biomarker result in a genomics-enabled clinical trial — a previously reported genomic or biomarker call being revised (e.g. a variant reclassified from VUS to pathogenic, a corrected HER2/EGFR status, or a re-adjudicated companion-diagnostic result). AtlaSent protects the AUTHORIZATION of the consequential change; it does not perform the scientific interpretation — the scientific basis comes from the laboratory method, the classification criteria, the protocol's context of use, and the designated authority. The gate requires authorized reviewers, supporting source evidence, a stated reason for change, the applicable study and laboratory criteria, and a traceable record of the prior and revised classification. A reported result is trial data of record; revising it can change a subject's eligibility, arm assignment, or safety profile, so it cannot be a silent overwrite. It must be attributable to a cryptographically verified qualified reviewer (a self-asserted actor_id from a LIS/LIMS is not sufficient), and no automated pipeline may reclassify a reported result on its own. Regulatory basis: 21 CFR Part 11 §11.10(b)/(e) (change-record and audit trail — not the scientific validity of the reclassification), ICH E6(R2) §5.5.3, ALCOA+, ICH E9 §5.",
    "family": "clinical.trial",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity",
        "regulatory"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(e) — Reason for Change",
        "mapping": "The reason for reclassifying the biomarker result is captured with the reviewer's verified identity and a timestamp in the signed audit event; the original reported result is preserved rather than overwritten.\n",
        "evidence_source": "audit_chain",
        "status_query": "biomarker_reclassification_reason_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(b) — Accurate and Complete Copies",
        "mapping": "A state snapshot binds the pre-reclassification result value into the permit (cdo_hash), providing the accurate copy of the record as it stood before the change.\n",
        "evidence_source": "permit_record",
        "status_query": "biomarker_reclassification_snapshot_pct"
      },
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §5.5.3 — Electronic Data Handling / Audit Trail",
        "mapping": "Every reclassification writes an immutable, attributable audit-chain entry naming the qualified reviewer, the trial, the assay, and the prior and new call.\n",
        "evidence_source": "audit_chain",
        "status_query": "biomarker_reclassification_audit_pct"
      },
      {
        "framework": "gxp_general",
        "clause": "ICH E9 §5 — Data Handling / Integrity of Trial Results",
        "mapping": "Reclassification requires a verified human reviewer and an approval artifact, so a genomic call that changes a subject's eligibility or analysis set is never altered by an automated process without attributable human authorization.\n",
        "evidence_source": "evaluation_record",
        "status_query": "biomarker_reclassification_human_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity",
        "regulatory"
      ],
      "notes": "The state snapshot captures the prior reported result value at authorization time and binds it into the permit, so the audit record proves exactly what the call was before the reclassification and who authorized the change.\n"
    },
    "use_case": "Gate the approval and release of a corrected or reinterpreted biomarker/genomic result behind a cryptographically verified qualified reviewer, supporting source evidence, a mandatory reason for change, the applicable study and laboratory criteria, and a preserved original value — so a sponsor can prove to the FDA or EMA that no reported genomic call was ever silently changed, and produce a signed prior/revised record for any reclassification. AtlaSent gates the authorization of the change; the scientific interpretation stays with the laboratory and the protocol's context of use.",
    "industries": [
      "pharma",
      "biotech",
      "cro",
      "genomics",
      "diagnostics"
    ]
  },
  {
    "id": "ACT-0047",
    "canon_id": "CANON-000044",
    "slug": "trial.biomarker.eligibility.override",
    "display_name": "Biomarker Eligibility Override",
    "description": "Authorization gate for overriding biomarker-defined eligibility in a genomics-enabled clinical trial — enrolling or retaining a subject whose genomic or biomarker result does not meet the protocol's inclusion/exclusion criteria (e.g. enrolling an EGFR-negative subject into an EGFR-targeted arm, or waiving a companion-diagnostic cutoff). This is a protocol deviation, not a routine screening decision: it changes who receives an investigational product and can affect subject safety and the analysis population. An override requires a documented medical rationale, a cryptographically verified qualified authorizer (medical monitor or principal investigator — a self-asserted actor_id is not sufficient), and an approval; it may not be granted by an automated screening system. Regulatory basis: ICH E6(R2) §4.5 / §4.3, 21 CFR 312.66, ICH E9 §5.2.",
    "family": "clinical.trial",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "identity",
        "regulatory"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §4.5.3–4 — Compliance with Protocol / Deviations",
        "mapping": "A deviation from protocol-defined eligibility requires documented medical authorization. AtlaSent binds the override permit to the authorizer's verified identity and rationale — the attributable, pre-hoc record GCP requires for a deviation.\n",
        "evidence_source": "audit_chain",
        "status_query": "eligibility_override_authorized_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR 312.66 — Assurance of IRB Review / Investigator Obligations",
        "mapping": "The override decision, its rationale, and the authorizing investigator/monitor are captured in the signed evaluation, evidencing the investigator's control over eligibility deviations.\n",
        "evidence_source": "evaluation_record",
        "status_query": "eligibility_override_investigator_pct"
      },
      {
        "framework": "gxp_general",
        "clause": "ICH E9 §5.2 — Analysis Sets / Protocol Deviations",
        "mapping": "Because an eligibility override affects the analysis population, it is authorized only by a verified human and recorded immutably, so deviations can be reconstructed for the statistical analysis plan.\n",
        "evidence_source": "audit_chain",
        "status_query": "eligibility_override_audit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "identity",
        "regulatory"
      ],
      "notes": "The override permit binds the authorizer's verified identity and the medical rationale, so the deviation record names who waived which biomarker criterion, for which subject, and why.\n"
    },
    "use_case": "Gate overriding a biomarker-defined eligibility criterion behind a cryptographically verified medical monitor or principal investigator with a documented rationale and an approval — so a sponsor can prove that every genomic-eligibility deviation was authorized by a named qualified human before the subject was enrolled, with a signed, offline-verifiable deviation record.",
    "industries": [
      "pharma",
      "biotech",
      "cro",
      "genomics"
    ]
  },
  {
    "id": "ACT-0048",
    "canon_id": "CANON-000045",
    "slug": "genomic.data.release",
    "display_name": "Identifiable Genomic Data Release",
    "description": "Authorization gate for releasing identifiable genomic data from a genomics-enabled trial — disclosing re-identifiable genomic or genetic data (whole-genome/exome sequences, variant call files, or genotype records tied to a subject) to a recipient such as an investigator, a treating clinician, a biobank, or a research collaborator. Genomic data is inherently re-identifiable and is special-category/genetic data under GDPR Art. 9, GINA, and HIPAA; a release is high-blast-radius and hard to recall. The gate requires a verified human authorizer, a verified consent assertion covering the disclosure, and an approved purpose before a permit is issued; a release outside the consented purpose or without a verified authorizer is denied. Regulatory basis: GDPR Art. 9 / Art. 6, HIPAA §164.508/§164.312(b), GINA (2008), 45 CFR 46.116 (informed consent).",
    "family": "data.release",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "consent",
        "sensitivity",
        "identity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 9 — Special Categories / Art. 6 — Lawfulness",
        "mapping": "Genetic data is special-category data. The release permit binds the verified consent assertion and the lawful purpose, providing the accountability record GDPR requires before disclosing Art. 9 data.\n",
        "evidence_source": "audit_chain",
        "status_query": "genomic_release_consent_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA §164.508 — Authorization / §164.312(b) — Audit Controls",
        "mapping": "A disclosure of identifiable genomic PHI is gated on a verified authorization and recorded with a tamper-evident permit naming the authorizer, recipient, and consent scope.\n",
        "evidence_source": "permit_record",
        "status_query": "genomic_release_authorization_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.15 — Logging / A.5.34 — Privacy & PII",
        "mapping": "Every identifiable genomic release writes an immutable, attributable audit-chain entry naming the authorizer, recipient, and sensitivity/consent scope.\n",
        "evidence_source": "audit_chain",
        "status_query": "genomic_release_audit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "consent",
        "sensitivity",
        "identity"
      ],
      "notes": "The consent and sensitivity assertions are bound into the permit so the audit record proves the identifiable genomic release matched a specific consent and stayed within the approved purpose and recipient.\n"
    },
    "use_case": "Gate release of identifiable genomic data behind a cryptographically verified authorizer, a verified consent assertion, and an approved purpose — so a sponsor or biobank can prove that every disclosure of re-identifiable genetic data matched a specific subject consent and lawful purpose, with a signed, offline-verifiable release record naming the authorizer and recipient.",
    "industries": [
      "pharma",
      "biotech",
      "genomics",
      "biobank",
      "healthtech"
    ]
  },
  {
    "id": "ACT-0049",
    "canon_id": "CANON-000046",
    "slug": "genomic.data.export",
    "display_name": "Cross-Border Genomic Data Export",
    "description": "Authorization gate for exporting genomic data to another organization or jurisdiction in a genomics-enabled trial — transferring genomic or genetic data across an organizational or geographic/legal boundary (to a sponsor abroad, a central sequencing lab in another country, or a partner in a different data-protection regime). A cross-border transfer of genetic data implicates data-residency and international-transfer law on top of consent: GDPR Chapter V (Art. 44–49), data-localization statutes, and jurisdiction-specific genetic-data rules. The gate requires a verified human authorizer, a verified data-residency assertion proving the destination is a permitted jurisdiction with a valid transfer mechanism, a verified consent covering cross-border transfer, and an approved purpose before a permit is issued. A transfer to a disallowed jurisdiction or outside the consented purpose is denied. Regulatory basis: GDPR Art. 44–49, GDPR Art. 9, data-localization statutes, GINA (2008).",
    "family": "data.release",
    "risk_posture": "critical",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "residency",
        "consent",
        "sensitivity"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 44–49 — Transfers of Personal Data to Third Countries",
        "mapping": "A cross-border transfer of genetic data requires a valid transfer mechanism and a permitted destination. The export permit binds a verified residency assertion naming the destination jurisdiction and transfer basis — the accountability record Chapter V requires.\n",
        "evidence_source": "audit_chain",
        "status_query": "genomic_export_residency_pct"
      },
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 9 — Special Categories (Genetic Data)",
        "mapping": "The export permit binds the verified consent covering cross-border transfer and the sensitivity scope, evidencing that Art. 9 genetic data left the origin jurisdiction only within its consented and lawful scope.\n",
        "evidence_source": "permit_record",
        "status_query": "genomic_export_consent_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.34 — Privacy & PII / A.8.15 — Logging",
        "mapping": "Every cross-border genomic export writes an immutable, attributable audit-chain entry naming the authorizer, destination organization/jurisdiction, and residency/consent scope.\n",
        "evidence_source": "audit_chain",
        "status_query": "genomic_export_audit_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-03",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "residency",
        "consent",
        "sensitivity"
      ],
      "notes": "The residency assertion is the load-bearing addition over genomic.data.release — it binds the destination jurisdiction and transfer mechanism into the permit so the audit record proves the cross-border genetic-data transfer stayed within a permitted, lawful scope.\n"
    },
    "use_case": "Gate exporting genomic data to another organization or jurisdiction behind a cryptographically verified authorizer, a verified data-residency assertion, a verified consent for cross-border transfer, and an approved purpose — so a sponsor can prove every international transfer of genetic data went to a permitted jurisdiction under a valid transfer mechanism, with a signed, offline-verifiable export record.",
    "industries": [
      "pharma",
      "biotech",
      "genomics",
      "cro",
      "biobank"
    ]
  },
  {
    "id": "ACT-0050",
    "canon_id": "CANON-000047",
    "slug": "communication.external.send",
    "display_name": "External Communication Send",
    "description": "Authorization gate for sending a communication (email or equivalent message) to a recipient outside the organization's boundary — the same \"release data beyond its original boundary\" consequence as a bulk export, at the scale of a single message. An outbound email carrying sensitive or customer information to a new external recipient is functionally a data-egress event: once sent, it cannot be recalled. The permit is bound to the exact recipient and attachment content authorized; any change to either after approval invalidates it. Applies identically whether the send is composed by a person, a workflow, a script, or an AI agent — none of them gain independent authority to release data externally merely by holding a connector credential to the mail platform.",
    "family": "data.release",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 5(1)(f) — Integrity and Confidentiality / Art. 44 — Transfers",
        "mapping": "AtlaSent binds each authorized external send to the exact recipient and content approved, giving a tamper-evident accountability record for personal-data disclosures leaving the organization by communication channel, not just by bulk export.\n",
        "evidence_source": "audit_chain",
        "status_query": "external_send_human_approval_pct"
      },
      {
        "framework": "soc2",
        "clause": "SOC 2 CC6.7 — Data Transmission and Disposal Controls",
        "mapping": "Every consequential outbound communication carries a signed permit proving the send was authorized, to whom, and with what content, before the mail platform transmits it.\n",
        "evidence_source": "permit_record",
        "status_query": "external_send_permit_coverage"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA Security Rule §164.312(e) — Transmission Security",
        "mapping": "Outbound communications carrying PHI to an external recipient are gated on human approval and an exact-binding permit before transmission, with the approval and content scope recorded in the immutable audit chain.\n",
        "evidence_source": "audit_chain",
        "status_query": "phi_external_send_gate_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The permit binds recipient, resource (message/attachment reference), and content-hash scope, so the audit record proves exactly what was authorized to be sent to whom. A recipient or attachment substitution after approval is a binding mutation, refused at verification time by the same generic exact-binding mechanism proven for access.grant/access.revoke (atlasent-api v1-evaluate / v1-verify-permit) — not a new primitive.\n"
    },
    "use_case": "Gate outbound communications carrying sensitive or customer information to new external recipients behind human approval and an exact recipient/content-bound permit — so a data leak, an AI agent auto-sending to the wrong address, or a customer-data disclosure with no authorization record becomes structurally impossible rather than a policy hope.",
    "industries": [
      "fintech",
      "healthtech",
      "saas",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0051",
    "canon_id": "CANON-000048",
    "slug": "trial.randomization.break",
    "display_name": "Trial Randomization Code Break",
    "description": "Authorization gate for breaking a clinical trial's randomization code for a single subject — revealing that one subject's treatment assignment (distinct from trial.unblinding.execute, CANON-000018, which reveals assignments trial-wide). A code break is typically triggered by a safety event and must be attributable to a named, verified approver, bound to the trial and subject, with an explicit reason.",
    "family": "clinical.trial",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "ich_e6_gcp",
        "clause": "ICH E6(R2) §4.8 — Breaking the Blind (subject-level)",
        "mapping": "A single-subject code break, triggered by a safety event, is captured as a verified human approval artifact bound to the trial and subject, with an explicit reason for the break.\n",
        "evidence_source": "audit_chain",
        "status_query": "gxp_randomization_break_approval_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.300 — Controls for Identification Codes",
        "mapping": "Multi-factor authentication is enforced via requires_mfa on every code-break request, evidencing that only an authenticated, trained individual triggered it.\n",
        "evidence_source": "evaluation_record",
        "status_query": "gxp_randomization_break_mfa_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The bundle requires trial_id, subject_id, and reason to be present; an unattributed or reasonless break falls through to a hold for manual review rather than a bare deny, matching the seeder's fallback template.\n"
    },
    "use_case": "Gate subject-level randomization code breaks behind a verified human approval and MFA, so a sponsor or CRO can prove every emergency code break was authorized by a named, authenticated investigator with a documented safety rationale.",
    "industries": [
      "pharma",
      "biotech",
      "cro"
    ]
  },
  {
    "id": "ACT-0052",
    "canon_id": "CANON-000049",
    "slug": "reconciliation.certify",
    "display_name": "Reconciliation — Certify",
    "description": "Authorization gate for certifying a period-end account reconciliation as complete and accurate — the officer certification step underlying SOX §302/§404. Allow requires the reviewer to have attested; runtime enforcement also requires a cryptographically resolvable, verified actor identity AND an issuer-scoped independent approver (the certifying approver cannot be the same identity as the requester) — a separation-of-duties gate.",
    "family": "finance.controllership",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §302 / §404 — Officer Certification of Internal Controls",
        "mapping": "A period-end reconciliation certification is captured as a verified human approval artifact from an issuer-scoped identity distinct from the requester — the certifying-officer independence §302/§404 assumes.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_reconciliation_certify_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "requires_independent_approval enforces that the certifier is not the requester at the runtime layer, ahead of the AC-5 requirement this control maps to.\n",
        "evidence_source": "permit_record",
        "status_query": "sox_reconciliation_sod_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
        "mapping": "Conflicting duties over a financial-close attestation are separated by the issuer-scoped independent-approval check.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_reconciliation_segregation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The bundle requires reviewer_attested=true; the independent-approval gate is enforced at the action_classes layer, not the bundle rule, and is not yet represented in this record's gate_flags (see the file-header note).\n"
    },
    "use_case": "Gate every period-end reconciliation certification behind a verified, independent human approval and MFA, so a controller can prove the officer certification SOX §302/§404 requires actually happened, with a self-approval-proof, offline-verifiable record.",
    "industries": [
      "fintech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0053",
    "canon_id": "CANON-000050",
    "slug": "journal_entry.approve",
    "display_name": "Journal Entry — Approve",
    "description": "Authorization gate for approving a manual journal entry above threshold — the decision that authorizes the entry for posting, distinct from journal.post (CANON-000041), which commits an already-approved entry to the ledger. Allow requires both journal_entry_id and approver_id to be present; runtime enforcement also requires a cryptographically resolvable, verified actor identity AND an issuer-scoped independent approver distinct from the preparer — the same segregation-of-duties gate as reconciliation.certify (CANON-000049).",
    "family": "finance.controllership",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "four-eyes",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX ITGC — Manual Journal Entry Segregation of Duties",
        "mapping": "A manual journal-entry approval is captured as a verified human approval artifact from an issuer-scoped identity distinct from the preparer — the preparer/approver segregation SOX ITGC controls require.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_journal_entry_approve_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-5 — Separation of Duties",
        "mapping": "requires_independent_approval enforces that the approver is not the preparer at the runtime layer, ahead of the AC-5 requirement this control maps to.\n",
        "evidence_source": "permit_record",
        "status_query": "sox_journal_entry_sod_pct"
      },
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.5.3 — Segregation of duties",
        "mapping": "Conflicting duties over a manual journal-entry approval are separated by the issuer-scoped independent-approval check.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_journal_entry_segregation_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The bundle requires journal_entry_id and approver_id to be present (else deny, not hold — a missing identifier is a malformed request, not one awaiting review). The independent-approval gate is enforced at the action_classes layer, not the bundle rule, and is not yet represented in this record's gate_flags (see the file-header note).\n"
    },
    "use_case": "Gate every manual journal-entry approval behind a verified, independent human approval and MFA, so a controller can prove the preparer/approver segregation SOX ITGC requires actually happened, before the entry ever reaches journal.post.",
    "industries": [
      "fintech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0054",
    "canon_id": "CANON-000051",
    "slug": "variance_review.escalate",
    "display_name": "Variance Review — Escalate",
    "description": "Authorization gate for escalating a budget/close variance review to a named reviewer — a lower-stakes review-routing action, not a dual-control certification like reconciliation.certify (CANON-000049) or journal_entry.approve (CANON-000050). Allow requires both variance_id and reason to be present; the runtime does not require MFA, a verified actor identity, or an independent approver for this class — a deliberately lighter gate than its two SOX-certification siblings, matching its lower blast radius.",
    "family": "finance.controllership",
    "risk_posture": "standard",
    "ai_risk": "Medium",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": false,
      "requires_state_snapshot": false,
      "required_assertion_classes": []
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Management Assessment of Internal Controls (close review)",
        "mapping": "A variance review escalation is captured as a verified human approval artifact bound to the variance and stated reason — a lower-stakes review-routing control that supports the broader close-review program §404 expects, without the dual-control weight of a certification action.\n",
        "evidence_source": "audit_chain",
        "status_query": "sox_variance_review_escalate_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-01",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "notes": "The bundle requires variance_id and reason to be present; an unattributed or reasonless escalation falls through to a hold for manual review rather than a bare deny, matching the seeder's fallback template.\n"
    },
    "use_case": "Gate variance-review escalations behind a verified human approval, so a controller can trace every escalated variance to a named reviewer and reason, without the dual-control overhead of a full certification action.",
    "industries": [
      "fintech",
      "enterprise",
      "saas",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0055",
    "canon_id": "CANON-000052",
    "slug": "industrial.safety.bypass",
    "display_name": "Safety Instrumented System Bypass",
    "description": "Authorization gate for bypassing or inhibiting a safety instrumented function (SIF) — a pressure trip, an emergency shutdown interlock, a fire & gas detection loop — to permit maintenance, testing, or a degraded operating mode. This is distinct from control.override (generic security-control bypass): a SIS bypass disables a layer of protection against a physical hazard (overpressure, fire, toxic release), not a security or compliance control, and carries its own regulatory regime (IEC 61511 bypass/inhibit management, OSHA PSM 1910.119(l) Management of Change, API RP 754). The permit binds the bypassed function tag, the mandatory compensating measure, and a hard expiry — the bypass must auto-revert; there is no open-ended bypass. Verification proves the function was RESTORED, not merely that it was disabled.",
    "family": "industrial.safety",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "approval",
        "identity",
        "risk"
      ]
    },
    "authorization_pattern": {
      "type": "human-only",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "iec_61511",
        "clause": "IEC 61511-1 Cl. 16.2.3 / 11.2.11 — Bypass and Override Management",
        "mapping": "Every SIS bypass captures a tamper-evident permit binding the safety function tag, the compensating measure in place, the process safety authority who authorized it, and the permit's hard expiry — the change-authorization and impairment-tracking evidence IEC 61511 requires for a safety instrumented function taken out of service.\n",
        "evidence_source": "audit_chain",
        "status_query": "sis_bypass_change_auth_pct"
      },
      {
        "framework": "osha_psm",
        "clause": "29 CFR 1910.119(l) — Management of Change",
        "mapping": "A bypass of a safety-critical control is a temporary change to the process safety basis; the permit captures the MOC-equivalent evidence (verified authorizer, technical basis for the compensating measure, time-bound duration) at the moment of bypass.\n",
        "evidence_source": "permit_record",
        "status_query": "sis_bypass_moc_evidence_pct"
      },
      {
        "framework": "api_rp_754",
        "clause": "API RP 754 — Process Safety Performance Indicators (Tier 1/2 near-miss basis)",
        "mapping": "Bypass duration and restoration confirmation are captured so an unrestored or overdue-expiry bypass is machine-detectable as a process-safety impairment, not discovered retroactively during an audit.\n",
        "evidence_source": "evaluation_record",
        "status_query": "sis_bypass_restoration_confirmed_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "approval",
        "identity",
        "risk"
      ],
      "notes": "The state_snapshot binds the safety function tag, the compensating measure, and the bypass duration at authorization time. A second evaluation at restoration time closes the loop — evidence is reconcilable against the DCS/SIS event log to detect an overdue or silently-extended bypass.\n"
    },
    "use_case": "Gate every safety instrumented system bypass behind process-safety-authority approval, a documented compensating measure, and a hard, permit-bound expiry — so a plant can prove every protective-function bypass was authorized, time-bound, and restored, not left open and discovered during the next incident investigation or IEC 61511 audit.",
    "industries": [
      "energy",
      "oil-and-gas",
      "chemicals",
      "utilities",
      "manufacturing"
    ]
  },
  {
    "id": "ACT-0056",
    "canon_id": "CANON-000053",
    "slug": "industrial.controller.configure",
    "display_name": "Industrial Controller Configuration Change",
    "description": "Authorization gate for downloading new control logic, program, or firmware to a physical-process controller — a PLC ladder-logic or function-block program, an RTU/IED configuration, or a DCS controller firmware image. This changes what the controller DOES the next time it runs, not a single command (industrial.control.actuate) and not IT/cloud infrastructure (infrastructure.change): it is a configuration-management event against a safety- and reliability-relevant device, gated at the engineering workstation before the download reaches the field controller. Release requires an isolated engineering workstation, offline test/simulation evidence, and a verified configuration-management sign-off; the resulting running configuration is snapshotted so a later evaluate can detect configuration drift against the approved version. Regulatory basis: IEC 62443-3-3 SR 3.4 / SR 7.6, NERC CIP-010-4.",
    "family": "industrial.control",
    "risk_posture": "critical",
    "ai_risk": "Extreme",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "approval",
        "identity",
        "supply_chain"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 2
    },
    "regulatory_mappings": [
      {
        "framework": "iec_62443",
        "clause": "IEC 62443-3-3 SR 3.4 — Software and Information Integrity",
        "mapping": "The permit binds a content hash of the downloaded logic/firmware image, so the evaluation record and audit chain prove exactly what configuration was authorized and deployed to the controller — the integrity evidence SR 3.4 requires.\n",
        "evidence_source": "audit_chain",
        "status_query": "ot_controller_config_integrity_pct"
      },
      {
        "framework": "iec_62443",
        "clause": "IEC 62443-3-3 SR 7.6 — Network and Security Configuration Settings",
        "mapping": "Every configuration change to a controller is authorized before download, with a verified engineer and a captured pre/post configuration snapshot — the configuration change-management evidence SR 7.6 requires.\n",
        "evidence_source": "permit_record",
        "status_query": "ot_controller_config_change_auth_pct"
      },
      {
        "framework": "nerc_cip",
        "clause": "NERC CIP-010-4 — Configuration Change Management and Vulnerability Assessments",
        "mapping": "The permit captures the device tag, the old->new configuration hash, and the authorizing engineer for every BES cyber system controller configuration change, satisfying CIP-010's baseline configuration and change-authorization evidence.\n",
        "evidence_source": "audit_chain",
        "status_query": "ot_controller_config_cip010_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-05",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "approval",
        "identity",
        "supply_chain"
      ],
      "notes": "The state_snapshot binds the device tag and the content hash of the old and new configuration/firmware image. The supply_chain assertion attests the image's origin (build/engineering-workstation provenance) before it is authorized for download. Evidence is reconcilable against the controller's running-configuration hash to detect drift between the authorized and deployed version.\n"
    },
    "use_case": "Gate every control-logic and firmware download to a PLC, RTU, or DCS controller behind independent engineering review, MFA, a verified engineer, and a permit bound to the exact configuration content hash — so a plant or utility can prove every controller change was reviewed, tested offline, and matches what was actually deployed, closing the gap where an unauthorized or untested logic change reaches a safety- or reliability-relevant device.",
    "industries": [
      "energy",
      "utilities",
      "oil-and-gas",
      "manufacturing",
      "water"
    ]
  },
  {
    "id": "ACT-0057",
    "canon_id": "CANON-000054",
    "slug": "secret.configuration.change",
    "display_name": "Secret Configuration Change",
    "description": "Authorization gate for changing a secret's ACCESS-CONTROL or GOVERNANCE configuration — granting or narrowing WHO or WHAT may read a secret (an IAM policy, KMS key policy, or Vault/Secrets Manager access policy attached to it), moving or re-provisioning WHERE it is stored, or changing its rotation policy or schedule. This is distinct from secret.rotate (CANON-000035), which governs rotating the secret's VALUE — a role-only, non-approved, machine-executable operation. Configuration changes are broader and higher-authority: widening who can read a live credential is a privilege-escalation-shaped decision (the same risk identity.privileged.grant governs for general entitlements), and relocating or degrading a secret's storage or rotation posture can silently weaken every control that depends on that secret staying rotated and access-scoped. Human approval, a verified and MFA'd approver, and a state snapshot binding the before/after configuration gate this action to a reviewed, identified change. secret.rotate's own scope is limited to VALUE rotation.",
    "family": "infrastructure.change",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": true,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "iso27001",
        "clause": "ISO/IEC 27001:2022 A.8.2 — Privileged Access Rights",
        "mapping": "Widening who may read a live secret is a privileged-access-rights change; AtlaSent records the approver's verified identity, MFA, and the before/after access-control configuration for every such change.\n",
        "evidence_source": "audit_chain",
        "status_query": "secret_config_privileged_access_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-6 — Least Privilege",
        "mapping": "A secret's access-control configuration is a least-privilege boundary; the permit captures the approved actor, the verified approver, and the resulting access-control state, evidencing AC-6 control over who may reach a stored credential.\n",
        "evidence_source": "permit_record",
        "status_query": "ac6_secret_config_change_pct"
      },
      {
        "framework": "pci_dss",
        "clause": "PCI DSS v4.0 Req. 7 — Restrict Access to System Components by Business Need to Know",
        "mapping": "Changing who can access a secret (including secrets protecting cardholder-data systems) is a need-to-know access-control event. AtlaSent provides the authorized, documented, MFA'd approval record PCI DSS requires before that access-control boundary is widened.\n",
        "evidence_source": "audit_chain",
        "status_query": "pci_secret_config_change_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-04",
      "approval_artifact_required": true,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity",
        "approval"
      ],
      "notes": "The state snapshot should capture the secret identity (name/ARN, never the value) and the before/after access-control policy, storage location, or rotation-policy configuration — whichever changed. Approval artifact records the verified approver.\n"
    },
    "use_case": "Gate every change to a production secret's access-control, storage, or rotation-policy configuration behind human approval, a verified MFA'd approver, and a before/after configuration snapshot — distinct from, and stricter than, the machine-executable gate for rotating the secret's value, so widening who can reach a live credential is never a same-privilege, unapproved event.",
    "industries": [
      "fintech",
      "saas",
      "healthtech",
      "enterprise",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0058",
    "canon_id": "CANON-000055",
    "slug": "sensitive_data.access",
    "display_name": "Sensitive Data Access",
    "description": "Authorization gate for a specific search, query, read, view, or unmasked reveal of personal, regulated, confidential, or otherwise sensitive data before any sensitive value is returned. The permit binds the declared purpose, data classification, target resource, requested fields, record or query scope, volume limit, initiating actor, and exact request-shape digest. This is not a standing entitlement: standing access to a data store remains identity.privileged.grant. It is also not data.export: permission to read never implies permission to transmit or release results to another destination. Routine least-privilege reads may be machine-executable under an active policy; direct identifiers, unusual volume, scope expansion, missing purpose, or unverified identity fail closed or route to separately configured human review.",
    "family": "data.access",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": false,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": true,
      "required_assertion_classes": [
        "identity",
        "sensitivity"
      ]
    },
    "authorization_pattern": {
      "type": "role-only",
      "machine_executable": true
    },
    "regulatory_mappings": [
      {
        "framework": "gdpr",
        "clause": "GDPR Art. 5(1)(b)-(c) — Purpose Limitation and Data Minimisation",
        "mapping": "The permit binds every sensitive-data request to an approved purpose, exact field projection, record or query scope, and maximum volume before values are returned.\n",
        "evidence_source": "permit_record",
        "status_query": "sensitive_data_access_purpose_scope_pct"
      },
      {
        "framework": "hipaa",
        "clause": "HIPAA Security Rule §164.312(a)(1) — Access Control",
        "mapping": "A verified execution identity and minimum-necessary request envelope are evaluated before access to electronic protected health information can proceed.\n",
        "evidence_source": "evaluation_record",
        "status_query": "phi_access_authorization_pct"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 Rev.5 AC-3 — Access Enforcement",
        "mapping": "AtlaSent enforces the organization's access policy at the data-operation boundary and records the exact actor, purpose, target, request digest, and decision.\n",
        "evidence_source": "audit_chain",
        "status_query": "ac3_sensitive_data_access_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": false,
      "state_snapshot_required": true,
      "required_assertions": [
        "identity",
        "sensitivity"
      ],
      "notes": "The state snapshot is the digest of the proposed request envelope: purpose, classification, target, field projection, record/query predicate, volume cap, and masking mode. Evidence stores identifiers, hashes, classifications, counts, and decisions only; raw personal data must never be copied into authorization or audit records.\n"
    },
    "use_case": "Put a fail-closed authorization decision directly in front of every sensitive-data search, query, read, view, or reveal — for human, service, and AI callers — so a valid credential cannot silently become authority to use personal data for any purpose, field set, record set, or volume.",
    "industries": [
      "enterprise",
      "saas",
      "fintech",
      "healthtech",
      "life-sciences",
      "regulated-industries"
    ]
  },
  {
    "id": "ACT-0059",
    "canon_id": "CANON-000056",
    "slug": "submission.submit",
    "display_name": "External Submission",
    "description": "Authorization gate for formally submitting an application or a regulatory, tax or legal filing to an outside authority on the organization's behalf — a grant, permit or licence application, a regulatory report, a tax return, a court or agency filing. A submission is a binding representation made in the organization's name: once the authority receives it, it cannot be recalled, only amended or withdrawn through the authority's own process, and it is attributed to the organization rather than to the person, workflow or AI agent that pressed submit. The permit is bound to the exact content, the recipient authority and the submitting entity; any change to any of them after authorization invalidates it. Applies identically whether the submission was prepared by a person, a script, a workflow or an AI agent — preparing the work confers no authority to commit the organization to it. AtlaSent does not prepare, review or file the submission and does not judge its content; it governs only whether this actor may submit this exact content, to this authority, for this entity, now.",
    "family": "data.release",
    "risk_posture": "high",
    "ai_risk": "High",
    "gate_flags": {
      "requires_human_approval": true,
      "requires_mfa": false,
      "requires_verified_actor": true,
      "requires_state_snapshot": false,
      "required_assertion_classes": [
        "identity",
        "approval"
      ]
    },
    "authorization_pattern": {
      "type": "approval-chain",
      "machine_executable": false,
      "minimum_approvals": 1
    },
    "regulatory_mappings": [
      {
        "framework": "sox",
        "clause": "SOX §404 — Internal Control over Financial Reporting (filing authorization)",
        "mapping": "AtlaSent gates each external financial or tax filing on a verified designated filer and a human approval bound to the exact filed content, giving an execution-time record of who was authorized to commit the organization to that filing.\n",
        "evidence_source": "audit_chain",
        "status_query": "submission_designated_filer_pct"
      },
      {
        "framework": "cfr_part_11",
        "clause": "21 CFR Part 11 §11.10(e) — Audit Trails for Electronic Records",
        "mapping": "Electronic submissions to FDA carry a permit bound to the exact submitted content hash and the submitting identity, recorded in the tamper-evident audit chain before transmission.\n",
        "evidence_source": "permit_record",
        "status_query": "regulatory_submission_permit_coverage"
      },
      {
        "framework": "nist_800_53",
        "clause": "NIST SP 800-53 AC-3 — Access Enforcement",
        "mapping": "The authority to submit on the organization's behalf is enforced at the submission transition itself, not inferred from holding a portal credential.\n",
        "evidence_source": "permit_record",
        "status_query": "submission_access_enforcement_pct"
      }
    ],
    "evidence_requirements": {
      "minimum_pattern": "EP-02",
      "approval_artifact_required": true,
      "state_snapshot_required": false,
      "required_assertions": [
        "identity",
        "approval"
      ],
      "notes": "The permit binds the content hash, the recipient authority and the submitting entity, so the record proves exactly what was authorized to be submitted, to whom, on whose behalf. The authority's submission receipt (confirmation number or acknowledgement) is execution/effect evidence recorded after the fact; it is kept separate from the authorization record and never substitutes for it. A content or recipient substitution after approval is a binding mutation, refused at verification by the generic exact-binding mechanism, not a new primitive.\n"
    },
    "use_case": "Gate applications and regulatory, tax and legal filings to outside authorities behind a verified designated filer and an exact content/recipient-bound permit — so software or an AI agent that prepares a submission can never commit the organization to it on its own authority.",
    "industries": [
      "fintech",
      "healthtech",
      "pharma",
      "enterprise",
      "regulated-industries"
    ]
  }
];
