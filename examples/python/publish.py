import requests

API = "https://YOUR_HOST"
TOKEN = "DEVICE_TOKEN"
DEVICE_ID = "DEVICE_ID"

r = requests.post(
    f"{API}/api/device/publish",
    headers={"Authorization": f"Bearer {TOKEN}"},
    json={"deviceId": DEVICE_ID, "topic": "telemetry", "data": {"temperature": 28.4, "humidity": 63}},
)
r.raise_for_status()
print(r.json())
