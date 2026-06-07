"""
models.py — re-export shim for goku-studio.

Studio owns models_studio.py. The Admin/Core models below (User, Tenant, etc.)
are READ ONLY in Studio — Studio never writes to them. They share the same
database as goku-core (shared-DB strategy, Phase B).

When goku-studio eventually gets its own database (Phase D), these imports
will be replaced by HTTP calls to the goku-core API.
"""

# ── Studio-owned models (read-write) ──────────────────────────────────────────
from app.models_studio import (                         # noqa: F401
    AgentDefinition,
    AgentAccessPolicy,
    UserAgentFavorite,
    Workflow,
    WorkflowExecution,
    WorkflowNodeExecution,
    Tool,
    AutoSkill,
    Plugin,
    MCPServer,
    MCPCapability,
    MCPResource,
    MCPPrompt,
    MCPPermission,
    MCPHealthRecord,
    MCPCallLog,
    MCPCapabilityAuthorization,
    MCPCapabilityBlacklist,
    MCPExternalConnection,
    KnowledgeDoc,
    ExternalMemorySource,
    DocPage,
    IraInvestor,
    IraEvent,
    IraEventParticipant,
    IraEmailTemplate,
    IraEmailQueue,
    IraCommunication,
    IraFollowupTask,
    IraAgentAction,
    IraInvestorGroup,
    IraInvestorGroupMember,
    IraApprovalRecord,
    IraMaterial,
    ImprovementProposal,
    ProposalOutcome,
    PromptExperiment,
    ToolCallStat,
)

# ── Core/Admin models (read-only cross-domain references) ─────────────────────
# Studio reads these but never writes to them.
# These classes are defined in goku-core; in the shared-DB setup we import
# them directly. In a split-DB setup they become HTTP lookups instead.
from app.models_admin import (                          # noqa: F401
    User,
    Tenant,
    Department,
    Team,
    Role,
    UserRole,
    UserDepartment,
    TokenBlacklist,
    SystemConfig,
    AuditLog,
)

from app.models_core import (                           # noqa: F401
    Task,
    TaskStatus,
    Memory,
    MemoryType,
    CostLedger,
)

from app.models_channels import (                       # noqa: F401
    IncomingEmail,
    IncomingEmailStatus,
)
