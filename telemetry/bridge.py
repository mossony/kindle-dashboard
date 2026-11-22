from datetime import datetime
import json
import math
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

import redis


WORKER_URL = "https://tesla.mossony.online/api/tesla/telemetry"
BATTERY_WRITE_INTERVAL_SECONDS = 300
CHARGE_STATES = {"Starting", "Charging", "Complete", "Stopped", "Disconnected", "NoPower"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BatteryBuffer:
    def __init__(self):
        self.pending = None
        self.latest_timestamp = -1
        self.next_send = 0

    def add(self, sample):
        if "level" in sample and sample["timestamp"] > self.latest_timestamp:
            self.latest_timestamp = sample["timestamp"]
            self.pending = {key: sample[key] for key in ("vin", "timestamp", "level")}

    def flush(self, now, send):
        if self.pending is None or now < self.next_send:
            return
        # Rate-limit attempts as well so a KV quota error cannot cause a retry loop.
        self.next_send = now + BATTERY_WRITE_INTERVAL_SECONDS
        if send(self.pending):
            self.pending = None


def extract_sample(payload, vin):
    if payload.get("vin") != vin:
        return None
    timestamp = datetime.fromisoformat(payload["createdAt"])
    if timestamp.tzinfo is None:
        return None
    sample = {"vin": vin, "timestamp": int(timestamp.timestamp() * 1000)}
    for datum in payload.get("data", []):
        value = datum.get("value") or {}
        if value.get("invalid"):
            continue
        if datum.get("key") == "BatteryLevel":
            for field in ("doubleValue", "floatValue", "intValue", "longValue", "stringValue"):
                if field in value:
                    try:
                        level = float(value[field])
                    except (ValueError, TypeError):
                        break
                    if math.isfinite(level) and 0 <= level <= 100:
                        sample["level"] = level
                    break
        if datum.get("key") == "DetailedChargeState":
            state = value.get("detailedChargeStateValue") or value.get("stringValue")
            if isinstance(state, str):
                state = state.removeprefix("DetailedChargeState")
                if state in CHARGE_STATES:
                    sample["chargingState"] = state
    return sample if len(sample) > 2 else None


def forward(opener, token, sample):
    request = Request(WORKER_URL, data=json.dumps(sample).encode(), headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "KindleDashboard-Tesla-Telemetry/1.0",
    }, method="POST")
    for attempt in range(3):
        try:
            with opener.open(request, timeout=8) as response:
                if response.status == 204:
                    print("Cloudflare accepted Tesla telemetry")
                    return True
                print(f"Unexpected Worker response: HTTP {response.status}")
                return False
        except HTTPError as error:
            print(f"Worker ingest returned HTTP {error.code}")
            if error.code < 500 and error.code != 429:
                return False
        except (URLError, TimeoutError):
            print("Worker ingest connection failed")
        if attempt < 2:
            time.sleep(2 ** attempt)
    return False


def main():
    vin = os.environ["TESLA_VIN"]
    token = os.environ["TESLA_TELEMETRY_TOKEN"]
    opener = build_opener(NoRedirect())
    battery = BatteryBuffer()
    last_charging_state = None
    last_charging_timestamp = -1

    def send(sample):
        return forward(opener, token, sample)

    client = redis.Redis(host="redis", decode_responses=True, socket_connect_timeout=5)
    with client.pubsub(ignore_subscribe_messages=True) as subscription:
        subscription.subscribe(f"kindle_V_{{{vin}}}")
        print("Tesla telemetry bridge listening")
        while True:
            message = subscription.get_message(timeout=1)
            sample = None
            if message:
                try:
                    sample = extract_sample(json.loads(message["data"]), vin)
                except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                    print("Ignored invalid telemetry record")
            if sample:
                battery.add(sample)
                state = sample.get("chargingState")
                if state is not None and sample["timestamp"] > last_charging_timestamp:
                    if state == last_charging_state or send({key: sample[key] for key in ("vin", "timestamp", "chargingState")}):
                        last_charging_state = state
                        last_charging_timestamp = sample["timestamp"]
            battery.flush(time.monotonic(), send)


if __name__ == "__main__":
    main()
