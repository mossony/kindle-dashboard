from datetime import datetime
import json
import math
import os
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

import redis


WORKER_URL = "https://tesla.mossony.online/api/tesla/telemetry"
CHARGE_STATES = {"Starting", "Charging", "Complete", "Stopped", "Disconnected", "NoPower"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
    }, method="POST")
    for attempt in range(3):
        try:
            with opener.open(request, timeout=8) as response:
                if response.status == 204:
                    return
                print(f"Unexpected Worker response: HTTP {response.status}")
                return
        except HTTPError as error:
            print(f"Worker ingest returned HTTP {error.code}")
            if error.code < 500 and error.code != 429:
                return
        except (URLError, TimeoutError):
            print("Worker ingest connection failed")
        if attempt < 2:
            time.sleep(2 ** attempt)


def main():
    vin = os.environ["TESLA_VIN"]
    token = os.environ["TESLA_TELEMETRY_TOKEN"]
    opener = build_opener(NoRedirect())
    client = redis.Redis(host="redis", decode_responses=True, socket_connect_timeout=5)
    with client.pubsub(ignore_subscribe_messages=True) as subscription:
        subscription.subscribe(f"kindle_V_{{{vin}}}")
        print("Tesla telemetry bridge listening")
        for message in subscription.listen():
            try:
                sample = extract_sample(json.loads(message["data"]), vin)
            except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                print("Ignored invalid telemetry record")
                continue
            if sample:
                forward(opener, token, sample)


if __name__ == "__main__":
    main()
