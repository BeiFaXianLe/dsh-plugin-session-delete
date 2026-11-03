/**
 * Browser half of dsh-plugin-session-delete (0.2.1-rc.x port).
 *
 * Registers one "Trash" capsule in the conversation session-header utilities
 * cluster (beside Session log). Clicking it confirms, then POSTs the current
 * session id to the host's loopback `/session-delete` route. The host detaches
 * the live session (emitting `session/disposed`, which the API proxy forwards so
 * every open client drops the row) and removes the persisted directory.
 *
 * No Harness Client package is imported as a module: React comes from the
 * browser module table and the icon is an inline SVG, so the entry cannot crash
 * on a missing primitive.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-delete",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const h = React.createElement;

		/** Dictionary namespace owned by this plugin. */
		const NS = "session-delete";
		const zh = {
			"header.aria": "删除此会话",
			"header.confirm": "确定删除当前会话「{name}」吗?此操作不可恢复。",
			"header.failed": "删除会话失败:{error}"
		};
		const en = {
			"header.aria": "Delete this session",
			"header.confirm": "Delete the current session \"{name}\"? This cannot be undone.",
			"header.failed": "Failed to delete session: {error}"
		};

		const inject = ["slots", "locale"];

		/** 16px outline trash icon, drawn inline so no client package is needed. */
		function TrashIcon({ size = 16 }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
					style: { display: "block", flex: "none" }
				},
				h("path", { d: "M4 7h16" }),
				h("path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }),
				h("path", { d: "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" }),
				h("path", { d: "M10 11v6M14 11v6" })
			);
		}

		/** The session-header action: one "Trash" capsule beside Session log. */
		function DeleteSessionAction({ sessionId, useSessions, t, remove, leave }) {
			const [busy, setBusy] = React.useState(false);
			const [hovered, setHovered] = React.useState(false);
			const title = useSessions((state) => state.byId?.[sessionId]?.displayTitle) ?? "";
			const onClick = async () => {
				if (busy) return;
				const name = title || sessionId;
				if (!window.confirm(t("header.confirm", { name }))) return;
				setBusy(true);
				try {
					const outcome = await remove(sessionId);
					if (outcome === undefined || outcome.ok === false) {
						window.alert(t("header.failed", { error: outcome?.error ?? "unknown" }));
						return;
					}
					const lines = Array.isArray(outcome.results) ? outcome.results : [];
					const failure = lines.find(
						(line) => typeof line === "string" && (line.includes("失败") || line.includes("拒绝"))
					);
					if (failure !== undefined) {
						window.alert(failure);
						return;
					}
					// The session is gone on the host. Leave the deleted conversation
					// (the app has no URL routing, so navigation is a client-store call)
					// and let the host's `api-session/removed` drop the sidebar row.
					setTimeout(leave, 30);
				} catch (error) {
					window.alert(t("header.failed", { error: String(error?.message ?? error) }));
				} finally {
					setBusy(false);
				}
			};
			return h(
				"button",
				{
					type: "button",
					onClick: () => void onClick(),
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					disabled: busy,
					title: t("header.aria"),
					"aria-label": t("header.aria"),
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						gap: "4px",
						height: "32px",
						padding: "6px 12px",
						borderRadius: "18px",
						border: "1px solid var(--dsw-alias-border-l2, #333)",
						color: "var(--dsw-alias-label-primary, inherit)",
						fontFamily: "var(--dsw-font-family, inherit)",
						fontSize: "13px",
						fontWeight: 400,
						lineHeight: "20px",
						whiteSpace: "nowrap",
						background:
							hovered && !busy
								? "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))"
								: "transparent",
						cursor: busy ? "default" : "pointer",
						marginInlineEnd: "30px",
						opacity: busy ? 0.5 : 1
					}
				},
				h(TrashIcon, { size: 16 }),
				h("span", null, "Trash")
			);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: dictionaries");
			const t = ctx.locale.bind(NS);
			const remove = async (sessionId) => {
				const response = await fetch("/session-delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok) return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
				return { ok: payload.ok !== false, results: payload.results };
			};
			// Leave the conversation being deleted. `uiWorkspace.clearMain()` is the
			// same primitive the shipped archive flow uses to clear a removed current
			// selection; fall back to a reload only if it is unavailable.
			const leave = () => {
				try {
					const navigation = ctx.get?.("uiWorkspace");
					if (navigation !== undefined && typeof navigation.clearMain === "function") {
						navigation.clearMain();
						return;
					}
				} catch {}
				try {
					window.location.reload();
				} catch {}
			};
			ctx.slots.inject("conversation.session.header.utilities", function* () {
				yield ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "session-delete",
						order: -1,
						locale: NS,
						inject: () => ({ t, remove, leave })
					},
					DeleteSessionAction
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
