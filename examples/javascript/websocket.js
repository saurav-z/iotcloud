const ws = new WebSocket("wss://YOUR_HOST/v1/ws?token=DEVICE_TOKEN");
ws.onopen = () => {
  ws.send(JSON.stringify({ action: "publish", topic: "telemetry", data: { temperature: 28.4 } }));
};
ws.onmessage = event => console.log(JSON.parse(event.data));
ws.onclose = () => console.log("disconnected");
