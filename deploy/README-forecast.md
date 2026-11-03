# forecast_renewables in operation

Two additions on the web machine, besides the normal `npm run deploy` (which copies `dist/`
and `models/`):

1. Monitoring timer (daily, as user `smard-mcp` with read access to the smard-forecast archive):

   ```
   install -m 644 deploy/forecast-monitor.service deploy/forecast-monitor.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now forecast-monitor.timer
   systemctl start forecast-monitor.service   # first run, then: journalctl -u forecast-monitor -n 20
   ```

2. The server reads `/var/lib/smard-mcp/forecast-monitor.json` (override with
   `SMARD_MCP_FORECAST_MONITOR`). Without the file, `recent_accuracy` is `null` and the tool says
   so in `notes`; reports older than three days are ignored.

New models arrive as branches `modelle/<version>` from the monthly retraining in
smard-forecast (`scripts/monatlich.sh`); merge them like any other change, then deploy.
