cd /e/ModelSpace/XiaomiMiMo/XiaomiMiMoProjects/gatepass
git add -A
git -c user.name=yuceyang -c user.email=yuceyang@users.noreply.github.com commit -m "feat: import/export the portable config from the web console

The console's settings page now carries a 多终端配置 panel with export
(with or without the password) and import. /api/config/export returns the
same gatepass-portable/v1 document the Android client reads, and
/api/config/import rebuilds the route table through RouteRegistry so
upstreamPort is inferred exactly as for a manually added route.

RouteRegistry.replaceAll() is shared by the console and the CLI import,
so both paths normalise, deduplicate and report skipped entries the same
way."
git push origin main
