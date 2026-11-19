package app.yingluo.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Observes SSE lifecycle without retaining reply text, credentials or reasoning. */
final class ReplyProgress {
    private final StringBuilder pending = new StringBuilder();
    private final StringBuilder data = new StringBuilder();
    String stage = "等待回复";
    int characters;
    boolean completed;
    boolean failed;

    void push(String chunk) {
        pending.append(chunk);
        int newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
            String line = pending.substring(0, newline).replace("\r", "");
            pending.delete(0, newline + 1);
            if (line.isEmpty()) { event(); }
            else if (line.startsWith("data:")) {
                if (data.length() > 0) data.append('\n');
                data.append(line.substring(5).trim());
            }
        }
    }

    private void text(String value) {
        if (!value.isEmpty()) { characters += value.codePointCount(0, value.length()); stage = "正在回复"; }
    }

    private void event() {
        String payload = data.toString();
        data.setLength(0);
        if (payload.isEmpty()) return;
        if ("[DONE]".equals(payload)) { completed = true; return; }
        try {
            JSONObject value = new JSONObject(payload);
            String type = value.optString("type");
            if (value.has("error") || "error".equals(type) || "response.failed".equals(type)
                    || "response.incomplete".equals(type)) { failed = true; return; }
            if ("message_stop".equals(type) || "response.completed".equals(type)) completed = true;
            if ("response.output_text.delta".equals(type)) text(value.optString("delta"));
            if (type.contains("reasoning")) stage = "思考中";
            JSONObject block = value.optJSONObject("content_block");
            if (block != null) {
                String kind = block.optString("type");
                if ("thinking".equals(kind)) stage = "思考中";
                if ("server_tool_use".equals(kind)) stage = "联网搜索";
                if ("web_search_tool_result".equals(kind)) stage = "整理资料";
                if ("text".equals(kind)) text(block.optString("text"));
            }
            JSONObject delta = value.optJSONObject("delta");
            if (delta != null) {
                if ("thinking_delta".equals(delta.optString("type"))) stage = "思考中";
                if ("text_delta".equals(delta.optString("type"))) text(delta.optString("text"));
            }
            JSONArray choices = value.optJSONArray("choices");
            if (choices != null && choices.length() > 0) {
                JSONObject choice = choices.getJSONObject(0);
                if (!choice.isNull("finish_reason") && !choice.optString("finish_reason").isEmpty()) completed = true;
                delta = choice.optJSONObject("delta");
                if (delta != null) {
                    if (!delta.optString("reasoning_content").isEmpty()) stage = "思考中";
                    Object content = delta.opt("content");
                    if (content instanceof String) text((String) content);
                    else if (content instanceof JSONArray) {
                        JSONArray parts = (JSONArray) content;
                        for (int i = 0; i < parts.length(); i++) text(parts.getJSONObject(i).optString("text"));
                    }
                }
            }
            JSONArray candidates = value.optJSONArray("candidates");
            if (candidates != null && candidates.length() > 0) {
                JSONObject candidate = candidates.getJSONObject(0);
                if (!candidate.optString("finishReason").isEmpty()) completed = true;
                JSONObject content = candidate.optJSONObject("content");
                JSONArray parts = content == null ? null : content.optJSONArray("parts");
                if (parts != null) for (int i = 0; i < parts.length(); i++) {
                    JSONObject part = parts.getJSONObject(i);
                    if (part.optBoolean("thought")) stage = "思考中";
                    else text(part.optString("text"));
                }
            }
        } catch (org.json.JSONException invalid) { failed = true; }
    }

    boolean successful() { return completed && !failed && characters > 0; }
}
