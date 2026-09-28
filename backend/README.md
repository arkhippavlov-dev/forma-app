# FORMA backend v0.21

This is only the transport foundation.

Current flow:

`recorded approach video -> POST /api/v1/analyze -> server receives bytes -> SHA-256 receipt -> browser`

No strong pose model is used yet. The current local MediaPipe analysis remains the fallback and still produces the visible result.

## Local start

```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

`GET /health`

Upload endpoint:

`POST /api/v1/analyze`

Multipart fields:
- `video`
- `exercise`
- `rep_count`
- `client_session_id`
- `client_duration_ms`
- `pose_format_version`

The uploaded video is written to temporary storage, verified, hashed, and deleted. V0.22 will run the strong pose model before deletion.
