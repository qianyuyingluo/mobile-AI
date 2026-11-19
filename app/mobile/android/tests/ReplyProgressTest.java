package app.yingluo.mobile;

public final class ReplyProgressTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static String event(String json) { return "data: " + json + "\r\n\r\n"; }
    public static void main(String[] args) {
        String reply = event("{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好😀\"}}")
                + event("{\"type\":\"message_stop\"}");
        for (int split = 0; split <= reply.length(); split++) {
            ReplyProgress progress = new ReplyProgress();
            progress.push(reply.substring(0, split));
            progress.push(reply.substring(split));
            check(progress.successful() && progress.characters == 3, "split UTF-16 / SSE boundary " + split);
        }
        ReplyProgress empty = new ReplyProgress();
        empty.push(event("[DONE]"));
        check(!empty.successful(), "empty reply must not wave");
        ReplyProgress failed = new ReplyProgress();
        failed.push(reply + event("{\"type\":\"error\",\"error\":{\"message\":\"test\"}}"));
        check(!failed.successful(), "error after partial reply must not wave");
        ReplyProgress interrupted = new ReplyProgress();
        interrupted.push(event("{\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}"));
        check(!interrupted.successful(), "EOF without terminal event must not wave");
        interrupted.push(event("[DONE]"));
        check(interrupted.successful(), "OpenAI completion");
        ReplyProgress phases = new ReplyProgress();
        phases.push(event("{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"private\"}}"));
        check("思考中".equals(phases.stage) && phases.characters == 0, "reasoning must not count as reply text");
        phases.push(event("{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\"}}"));
        check("联网搜索".equals(phases.stage), "search stage");
        ReplyProgress malformed = new ReplyProgress();
        malformed.push(event("not-json") + reply);
        check(!malformed.successful(), "malformed stream must not report success");
        System.out.println("PASS: native SSE split boundaries, stages, Unicode, completion, errors, and interrupted replies");
    }
}
