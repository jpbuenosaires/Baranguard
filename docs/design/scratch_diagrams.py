import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.lines import Line2D

NAVY = "#1D3557"
BLUE = "#2563EB"
GREEN = "#15803D"
ORANGE = "#B45309"
GRAY = "#64748B"
LIGHT = "#F1F5F9"
RED = "#DC2626"

def box(ax, x, y, w, h, text, fc=LIGHT, ec=NAVY, fontsize=10, fontweight="bold", textcolor=NAVY, style="round,pad=0.02,rounding_size=0.02"):
    b = FancyBboxPatch((x, y), w, h, boxstyle=style, linewidth=1.6, edgecolor=ec, facecolor=fc, zorder=2)
    ax.add_patch(b)
    ax.text(x + w/2, y + h/2, text, ha="center", va="center", fontsize=fontsize,
             fontweight=fontweight, color=textcolor, zorder=3, wrap=True)
    return (x, y, w, h)

def arrow(ax, p1, p2, color=GRAY, style="-|>", lw=1.6, ls="solid", label=None, label_pos=0.5, fontsize=8.3, curve=0.0):
    a = FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=14, linewidth=lw,
                         color=color, linestyle=ls, zorder=1,
                         connectionstyle=f"arc3,rad={curve}")
    ax.add_patch(a)
    if label:
        mx = p1[0] + (p2[0]-p1[0])*label_pos
        my = p1[1] + (p2[1]-p1[1])*label_pos + (0.18 if curve == 0 else curve*2.2)
        ax.text(mx, my, label, ha="center", va="center", fontsize=fontsize, color=color,
                 bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.85), zorder=4)

def new_fig(w, h):
    fig, ax = plt.subplots(figsize=(w, h), dpi=200)
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.axis("off")
    return fig, ax

# ---------------------------------------------------------------------------
# 1. ARCHITECTURE DIAGRAM (finalized target: cloud-hosted + offline-first)
# ---------------------------------------------------------------------------
fig, ax = new_fig(11, 7.2)

ax.text(5.5, 6.85, "Baranguard — Finalized Target Architecture", ha="center", fontsize=14, fontweight="bold", color=NAVY)
ax.text(5.5, 6.5, "Cloud-hosted layered architecture + offline-first Tanod mobile client", ha="center", fontsize=9.5, color=GRAY, style="italic")

# Client tier
b_web = box(ax, 0.5, 5.0, 3.0, 1.0, "Web Dashboard\n(Browser — Admin / Punong Barangay)", fc="#DBEAFE", ec=BLUE, textcolor=NAVY)
b_mob = box(ax, 7.5, 5.0, 3.0, 1.0, "Tanod Mobile App\nOffline-first — Ionic/Capacitor + SQLite", fc="#DCFCE7", ec=GREEN, textcolor=NAVY)

# Cloud boundary
cloud = FancyBboxPatch((3.9, 1.1), 3.2, 4.6, boxstyle="round,pad=0.03,rounding_size=0.05",
                         linewidth=1.8, edgecolor=NAVY, facecolor="#F8FAFC", linestyle=(0, (5, 3)), zorder=0)
ax.add_patch(cloud)
ax.text(5.5, 5.55, "CLOUD-HOSTED BACKEND (HTTPS)", ha="center", fontsize=8.5, fontweight="bold", color=NAVY)

b_api = box(ax, 4.1, 4.0, 2.8, 1.0, "API Layer\nPHP — REST /api/v1 (role + tenant checked\non every request)", fc="#EFF6FF", ec=BLUE, fontsize=9)
b_db = box(ax, 4.1, 2.6, 2.8, 1.0, "Database\nCloud-hosted MariaDB", fc="#EFF6FF", ec=BLUE, fontsize=9.5)
b_ai = box(ax, 4.1, 1.25, 2.8, 1.0, "AI Redaction Worker\nSelf-hosted Llama-SEA-LION (Ollama)\nnarrative summary + PII redaction only", fc="#FEF3C7", ec=ORANGE, fontsize=8, textcolor=ORANGE)

b_sms = box(ax, 0.5, 2.7, 3.0, 1.0, "SMS Gateway\n(Semaphore — best-effort fallback)", fc="#FEE2E2", ec=RED, textcolor=RED, fontsize=9.5)

b_sos = box(ax, 7.5, 2.7, 3.0, 1.0, "GPS / SOS Ingest\n(live tracking, GIS heatmap)", fc="#DCFCE7", ec=GREEN, textcolor=NAVY, fontsize=9)

# Arrows
arrow(ax, (2.0, 5.0), (4.3, 4.75), label="HTTPS (JSON)")
arrow(ax, (9.0, 5.0), (6.7, 4.75), label="HTTPS (sync when online)")
arrow(ax, (5.5, 4.0), (5.5, 3.6), label="reads/writes")
arrow(ax, (5.5, 2.6), (5.5, 2.25), label="enqueues job", color=ORANGE)
arrow(ax, (2.0, 3.2), (4.1, 3.2), label="dispatch\ncoords", color=RED, fontsize=7.6)
arrow(ax, (9.0, 3.7), (6.9, 4.05), color=GREEN)
arrow(ax, (9.0, 5.0), (9.0, 3.7), color=GREEN, label="GPS ping", label_pos=0.5)

# SMS fallback path (dashed) direct mobile <-> SMS gateway, bypassing HTTPS when broadband is down
arrow(ax, (7.6, 5.05), (2.3, 3.55), color=RED, ls=(0, (4, 3)), lw=1.4, curve=-0.25,
      label="SMS fallback — broadband down\n(coords parsed from SMS body)", label_pos=0.5, fontsize=7.3)

ax.text(0.55, 1.15, "Removed vs. proposal: no LAN-only single workstation, no Katarungang\nPambarangay (KP) referral / Lupon Case Packet module.",
        fontsize=8, color=GRAY, style="italic")

plt.tight_layout()
plt.savefig("diagram_architecture.png", bbox_inches="tight")
plt.close(fig)

# ---------------------------------------------------------------------------
# 2. SIMPLIFIED ERD (finalized target schema, KP entities removed)
# ---------------------------------------------------------------------------
fig, ax = new_fig(12, 8.5)
ax.text(6, 8.25, "Baranguard — Finalized Target ERD (simplified)", ha="center", fontsize=14, fontweight="bold", color=NAVY)
ax.text(6, 7.9, "Crow's Foot cardinality; KP/Lupon entities removed per panel recommendation", ha="center", fontsize=9, color=GRAY, style="italic")

def entity(ax, x, y, w, h, title, rows, fc="#EFF6FF", ec=BLUE):
    box(ax, x, y, w, h, "", fc=fc, ec=ec)
    ax.add_patch(FancyBboxPatch((x, y+h-0.42), w, 0.42, boxstyle="square,pad=0", linewidth=0, facecolor=ec, zorder=3))
    ax.text(x+w/2, y+h-0.21, title, ha="center", va="center", fontsize=9, fontweight="bold", color="white", zorder=4)
    for i, r in enumerate(rows):
        ax.text(x+0.12, y+h-0.62-i*0.28, r, ha="left", va="center", fontsize=7.4, color=NAVY, zorder=4)

entity(ax, 0.3, 6.9, 2.3, 1.3, "barangay", ["PK barangay_id", "name, municipality"])
entity(ax, 0.3, 4.6, 2.3, 1.9, "user", ["PK user_id", "FK barangay_id", "role, is_active,", "is_suspended"])
entity(ax, 0.3, 2.2, 2.3, 1.6, "mobile_device", ["PK device_id", "FK user_id", "device_secret_hash"])
entity(ax, 0.3, 0.2, 2.3, 1.6, "duty_status /\nshift_schedule", ["FK user_id", "status, changed_at"])

entity(ax, 3.4, 5.6, 2.6, 2.2, "incident", ["PK incident_id", "FK barangay_id", "type, status, priority", "raw_narrative*", "redacted_narrative", "* Secretary/Records-", "  role read only"])
entity(ax, 3.4, 3.5, 2.6, 1.6, "dispatch", ["PK dispatch_id", "FK incident_id", "FK tanod_id (user)", "status, timestamps"])
entity(ax, 3.4, 1.6, 2.6, 1.3, "evidence_attachment", ["PK attachment_id", "FK incident_id"])
entity(ax, 3.4, 0.2, 2.6, 1.1, "citizen_report", ["PK report_id", "FK incident_id (nullable)"])

entity(ax, 6.6, 5.6, 2.6, 1.6, "gps_track /\ntanod_sos", ["FK device_id / user_id", "lat, lng, age_seconds"])
entity(ax, 6.6, 3.6, 2.6, 1.6, "ai_processing_log", ["PK log_id", "FK incident_id", "task_type, status"])
entity(ax, 6.6, 1.7, 2.6, 1.6, "notification /\nnotification_target", ["PK notification_id", "entity_type, entity_id"])
entity(ax, 6.6, 0.2, 2.6, 1.1, "sms_log", ["FK barangay_id", "direction, status"])

entity(ax, 9.5, 5.6, 2.2, 1.6, "ai_evaluation_run", ["PK run_id", "dataset, metrics"])
entity(ax, 9.5, 3.7, 2.2, 1.5, "audit_log", ["FK user_id", "action, entity"])
entity(ax, 9.5, 1.8, 2.2, 1.5, "map_package /\nsystem_settings", ["standalone config"])

removed = FancyBboxPatch((9.5, 0.2), 2.2, 1.2, boxstyle="round,pad=0.02", linewidth=1.6,
                           edgecolor=RED, facecolor="#FEE2E2", linestyle=(0, (4, 3)), zorder=2)
ax.add_patch(removed)
ax.text(10.6, 0.8, "REMOVED:\nblotter_record\nblotter_revision", ha="center", va="center", fontsize=8, fontweight="bold", color=RED, zorder=3)

# relationship lines (simple, labeled)
def rel(ax, p1, p2, label):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle="-", linewidth=1.3, color=GRAY, zorder=1))
    mx, my = (p1[0]+p2[0])/2, (p1[1]+p2[1])/2
    ax.text(mx, my, label, ha="center", va="center", fontsize=6.6, color=GRAY,
             bbox=dict(boxstyle="round,pad=0.1", fc="white", ec="none", alpha=0.9), zorder=4)

rel(ax, (2.6, 7.4), (3.4, 6.7), "1:N")
rel(ax, (2.6, 5.5), (3.4, 6.3), "1:N")
rel(ax, (2.6, 3.0), (3.4, 4.3), "1:N")
rel(ax, (2.6, 1.0), (3.4, 3.9), "1:N")
rel(ax, (6.0, 6.4), (6.6, 6.4), "1:N")
rel(ax, (6.0, 4.3), (6.6, 4.4), "1:N")
rel(ax, (6.0, 2.2), (6.6, 2.5), "0:N")
rel(ax, (6.0, 0.75), (6.6, 0.75), "0:N")
rel(ax, (9.2, 6.4), (9.5, 6.4), "N:1")
rel(ax, (9.2, 4.3), (9.5, 4.4), "N:1")
rel(ax, (2.6, 5.4), (3.4, 1.0), "0:N")

plt.tight_layout()
plt.savefig("diagram_erd.png", bbox_inches="tight")
plt.close(fig)

# ---------------------------------------------------------------------------
# 3. DFD - Context (Level 0) and Level 1
# ---------------------------------------------------------------------------
fig, ax = new_fig(11, 6.2)
ax.text(5.5, 5.9, "Context Diagram (Level 0)", ha="center", fontsize=14, fontweight="bold", color=NAVY)

ext_style = dict(fc="#F1F5F9", ec=NAVY)
citizen = box(ax, 0.4, 4.3, 2.1, 1.0, "Citizen", **ext_style, fontsize=10)
tanod = box(ax, 0.4, 2.3, 2.1, 1.0, "Tanod\n(Field Responder)", **ext_style, fontsize=9.5)
admin = box(ax, 0.4, 0.3, 2.1, 1.0, "Admin / Dispatcher", **ext_style, fontsize=9.5)
pb = box(ax, 8.6, 4.3, 2.1, 1.0, "Punong Barangay\n(Oversight)", **ext_style, fontsize=9)
sms_net = box(ax, 8.6, 2.3, 2.1, 1.0, "SMS Network\n(Semaphore)", **ext_style, fontsize=9.5)
ai_ext = box(ax, 8.6, 0.3, 2.1, 1.0, "Self-hosted AI Model\n(Llama-SEA-LION)", **ext_style, fontsize=8.6)

center = FancyBboxPatch((3.4, 1.9), 3.7, 2.4, boxstyle="round,pad=0.03,rounding_size=0.08",
                          linewidth=2, edgecolor=BLUE, facecolor="#DBEAFE", zorder=2)
ax.add_patch(center)
ax.text(5.25, 3.1, "0\nBaranguard Dispatch &\nIntelligence System", ha="center", va="center",
        fontsize=10.5, fontweight="bold", color=NAVY, zorder=3)

arrow(ax, (2.5, 4.7), (3.4, 3.7), label="report + location")
arrow(ax, (2.5, 2.8), (3.4, 3.0), label="GPS ping / SOS /\nincident capture", fontsize=7.3)
arrow(ax, (2.5, 0.9), (3.4, 2.3), label="dispatch command")
arrow(ax, (7.1, 3.3), (8.6, 4.6), label="reports / heatmap")
arrow(ax, (7.1, 2.9), (8.6, 2.8), label="SMS out/in", color=RED)
arrow(ax, (7.1, 2.4), (8.6, 0.8), label="redaction job", color=ORANGE)
arrow(ax, (8.6, 0.55), (7.1, 2.15), label="redacted summary", color=ORANGE, curve=0.15)

plt.tight_layout()
plt.savefig("diagram_dfd_context.png", bbox_inches="tight")
plt.close(fig)

fig, ax = new_fig(12, 7.6)
ax.text(6, 7.3, "Level 1 DFD — Major Subprocesses", ha="center", fontsize=14, fontweight="bold", color=NAVY)

def process(ax, x, y, w, h, num, title):
    box(ax, x, y, w, h, f"{num}\n{title}", fc="#DBEAFE", ec=BLUE, fontsize=8.6)

def store(ax, x, y, w, h, label):
    ax.add_patch(plt.Rectangle((x, y), w, h, fill=False, edgecolor=NAVY, linewidth=1.4, zorder=2))
    ax.plot([x, x+w], [y+h, y+h], color=NAVY, linewidth=1.4, zorder=2)
    ax.text(x+w/2, y+h/2, label, ha="center", va="center", fontsize=7.6, color=NAVY, zorder=3)

process(ax, 0.5, 5.6, 2.4, 1.3, "1.0", "Incident Intake\n& Dispatch")
process(ax, 3.4, 5.6, 2.4, 1.3, "2.0", "Field Data Capture\n& Offline Sync")
process(ax, 6.3, 5.6, 2.4, 1.3, "3.0", "AI Narrative\nRedaction")
process(ax, 9.2, 5.6, 2.4, 1.3, "4.0", "Notification &\nSMS Alerting")
process(ax, 4.9, 3.4, 2.4, 1.3, "5.0", "Reporting,\nHeatmap & Analytics")

store(ax, 0.3, 3.6, 2.6, 0.9, "D1  incident / dispatch")
store(ax, 3.3, 3.6, 2.4, 0.9, "D2  gps_track / tanod_sos")
store(ax, 6.9, 3.6, 2.6, 0.9, "D3  ai_processing_log")
store(ax, 9.6, 3.6, 2.4, 0.9, "D4  notification / sms_log")
store(ax, 2.9, 1.4, 2.6, 0.9, "D1  incident / dispatch")
store(ax, 6.0, 1.4, 2.8, 0.9, "D5  audit_log")

arrow(ax, (1.7, 5.6), (1.6, 4.5), label="writes")
arrow(ax, (4.6, 5.6), (4.5, 4.5), label="writes")
arrow(ax, (7.5, 5.6), (8.2, 4.5), label="writes")
arrow(ax, (10.4, 5.6), (10.8, 4.5), label="writes")
arrow(ax, (2.9, 6.25), (3.4, 6.25), label="assignment")
arrow(ax, (5.8, 6.25), (6.3, 6.25), label="raw narrative", color=ORANGE)
arrow(ax, (8.7, 6.25), (9.2, 6.25), label="SOS / status change")
arrow(ax, (6.05, 4.7), (6.0, 3.9), color=NAVY)
arrow(ax, (6.0, 4.7), (6.0, 2.7), curve=-0.2, color=GRAY, label="reads all stores", fontsize=7)

plt.tight_layout()
plt.savefig("diagram_dfd_level1.png", bbox_inches="tight")
plt.close(fig)

print("done")
