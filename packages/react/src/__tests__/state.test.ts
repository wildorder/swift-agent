import { describe, it, expect } from 'vitest';
import { chatReducer, initialChatState } from '../state.js';
import type { ChatState } from '../state.js';
import type { ChatMessage, ToolCallInfo } from '../types.js';

describe('chatReducer', () => {
  describe('SEND_USER', () => {
    it('appends a pending user message and sets isStreaming', () => {
      const state = chatReducer(initialChatState, {
        type: 'SEND_USER',
        id: 'u1',
        content: 'hello',
      });

      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual({
        id: 'u1',
        role: 'user',
        content: 'hello',
        status: 'pending',
      });
      expect(state.isStreaming).toBe(true);
      expect(state.lastError).toBeNull();
    });
  });

  describe('message_started', () => {
    it('appends a streaming assistant message and marks pending user messages complete', () => {
      const withUser = chatReducer(initialChatState, {
        type: 'SEND_USER',
        id: 'u1',
        content: 'hi',
      });

      const state = chatReducer(withUser, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });

      expect(state.messages).toHaveLength(2);
      const userMsg = state.messages[0] as ChatMessage;
      expect(userMsg.status).toBe('complete');
      expect(state.messages[1]).toEqual({
        id: 'msg_1',
        role: 'assistant',
        content: '',
        status: 'streaming',
      });
      expect(state.isStreaming).toBe(true);
    });
  });

  describe('token', () => {
    it('appends text to the streaming assistant message', () => {
      let state: ChatState = initialChatState;
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      state = chatReducer(state, {
        type: 'token',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        text: 'Hello',
      });
      state = chatReducer(state, {
        type: 'token',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        text: ' world',
      });

      const msg = state.messages[0] as ChatMessage;
      expect(msg.content).toBe('Hello world');
      expect(msg.status).toBe('streaming');
    });
  });

  describe('tool_call_started', () => {
    it('adds a tool call to the streaming assistant message', () => {
      let state: ChatState = initialChatState;
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      state = chatReducer(state, {
        type: 'tool_call_started',
        callId: 'tc_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        toolName: 'lookupOrder',
      });

      const msg = state.messages[0] as ChatMessage;
      expect(msg.toolCalls).toEqual([
        { callId: 'tc_1', toolName: 'lookupOrder', status: 'started' },
      ]);
    });
  });

  describe('tool_call_completed', () => {
    it('updates the tool call status', () => {
      let state: ChatState = initialChatState;
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      state = chatReducer(state, {
        type: 'tool_call_started',
        callId: 'tc_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        toolName: 'lookupOrder',
      });
      state = chatReducer(state, {
        type: 'tool_call_completed',
        callId: 'tc_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        toolName: 'lookupOrder',
        status: 'completed',
      });

      const msg = state.messages[0] as ChatMessage;
      const toolCall = (msg.toolCalls as ToolCallInfo[])[0] as ToolCallInfo;
      expect(toolCall.status).toBe('completed');
    });
  });

  describe('message_completed', () => {
    it('marks the assistant message complete and clears isStreaming', () => {
      let state: ChatState = initialChatState;
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      state = chatReducer(state, {
        type: 'token',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
        text: 'Done',
      });
      state = chatReducer(state, {
        type: 'message_completed',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });

      const msg = state.messages[0] as ChatMessage;
      expect(msg.status).toBe('complete');
      expect(msg.content).toBe('Done');
      expect(state.isStreaming).toBe(false);
    });
  });

  describe('run_failed', () => {
    it('sets lastError and clears isStreaming', () => {
      let state: ChatState = initialChatState;
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      state = chatReducer(state, {
        type: 'run_failed',
        runId: 'run_1',
        sessionId: 'ses_1',
        code: 'MODEL_ERROR',
        message: 'Something went wrong',
      });

      expect(state.isStreaming).toBe(false);
      // lastError is the code-prefixed, readable string (WS-41) — never a raw object.
      expect(state.lastError).toBe('[MODEL_ERROR] Something went wrong');
      expect(state.lastError).not.toContain('[object');
      // Streaming message should be marked complete
      const msg = state.messages[0] as ChatMessage;
      expect(msg.status).toBe('complete');
    });
  });

  describe('RESET_ERROR', () => {
    it('clears the lastError', () => {
      const state = chatReducer(
        { ...initialChatState, lastError: 'oops' },
        { type: 'RESET_ERROR' },
      );
      expect(state.lastError).toBeNull();
    });
  });

  describe('CONNECTION_STATUS', () => {
    it('updates connection status', () => {
      const state = chatReducer(initialChatState, {
        type: 'CONNECTION_STATUS',
        status: 'connected',
      });
      expect(state.connectionStatus).toBe('connected');
    });
  });

  describe('full conversation flow', () => {
    it('handles a complete user→assistant exchange', () => {
      let state: ChatState = initialChatState;

      // User sends
      state = chatReducer(state, { type: 'SEND_USER', id: 'u1', content: 'What is 2+2?' });
      expect(state.messages).toHaveLength(1);
      expect(state.isStreaming).toBe(true);

      // Assistant starts
      state = chatReducer(state, {
        type: 'message_started',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      expect(state.messages).toHaveLength(2);
      const userMsg = state.messages[0] as ChatMessage;
      let assistantMsg = state.messages[1] as ChatMessage;
      expect(userMsg.status).toBe('complete'); // user msg
      expect(assistantMsg.status).toBe('streaming'); // assistant msg

      // Tokens stream in
      state = chatReducer(state, {
        type: 'token', messageId: 'msg_1', runId: 'run_1', sessionId: 'ses_1', text: '2+2',
      });
      state = chatReducer(state, {
        type: 'token', messageId: 'msg_1', runId: 'run_1', sessionId: 'ses_1', text: ' = 4',
      });
      assistantMsg = state.messages[1] as ChatMessage;
      expect(assistantMsg.content).toBe('2+2 = 4');

      // Assistant completes
      state = chatReducer(state, {
        type: 'message_completed',
        messageId: 'msg_1',
        runId: 'run_1',
        sessionId: 'ses_1',
      });
      assistantMsg = state.messages[1] as ChatMessage;
      expect(assistantMsg.status).toBe('complete');
      expect(state.isStreaming).toBe(false);
    });
  });
});
