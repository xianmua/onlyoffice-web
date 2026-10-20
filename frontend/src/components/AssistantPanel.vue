<template>
  <!-- 悬浮按钮：收起态 -->
  <button
    v-if="!open"
    class="fab"
    @click="open = true"
    title="AI 助手"
  >
    🤖
  </button>

  <!-- 主面板：展开态 -->
  <div v-else class="panel">
    <header class="head">
      <span class="title">AI 助手</span>
      <span class="badge" :class="mode">{{ modeText }}</span>
      <span class="spacer"></span>
      <button class="x" @click="open = false" title="收起">×</button>
    </header>

    <div class="msgs" ref="boxRef">
      <div v-if="messages.length === 0" class="empty">
        输入指令，例如：<br />
        <code>把第一段改写成更正式的商务口吻</code><br />
        <code>删除所有重复的换行</code>
      </div>

      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg"
        :class="m.role"
      >
        <div class="bubble">{{ m.text }}</div>
        <div v-if="m.actions && m.actions.length" class="actions">
          <span
            v-for="(a, j) in m.actions"
            :key="j"
            class="action-tag"
          >
            ✎ {{ a.summary }}
          </span>
        </div>
      </div>

      <div v-if="sending" class="msg assistant">
        <div class="bubble pending">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    </div>

    <form class="input" @submit.prevent="send">
      <input
        v-model="text"
        :disabled="sending"
        placeholder="输入修改指令..."
        autofocus
      />
      <button type="submit" :disabled="!text.trim() || sending">发送</button>
    </form>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue'

const props = defineProps({
  docReady: { type: Boolean, default: false },
})
const emit = defineEmits(['apply-edit'])

const getDocUrl = inject('getDocUrl', () => '')

const open = ref(false)
const text = ref('')
const sending = ref(false)
const messages = ref([])
const mode = ref('stub')
const boxRef = ref(null)

const modeText = computed(() =>
  mode.value === 'dsh' ? 'DSH' : '本地 stub'
)

async function refreshMode() {
  try {
    const r = await fetch('/api/health')
    const j = await r.json()
    mode.value = j.dshUsable ? 'dsh' : 'stub'
  } catch {
    mode.value = 'offline'
  }
}

onMounted(() => {
  refreshMode()
  setInterval(refreshMode, 10000)
})

watch(
  () => messages.value.length,
  async () => {
    await nextTick()
    if (boxRef.value) boxRef.value.scrollTop = boxRef.value.scrollHeight
  }
)

async function send() {
  const msg = text.value.trim()
  if (!msg || sending.value) return
  text.value = ''
  messages.value.push({ role: 'user', text: msg })
  sending.value = true
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg,
        docUrl: getDocUrl() || '',
      }),
    })
    const j = await r.json()
    messages.value.push({
      role: 'assistant',
      text: j.message || '(无回复)',
      actions: j.actions || [],
    })
    // 有插入动作时，把 AI 回复正文交给父组件 → 队列 → 插件写入文档
    if (j.actions && j.actions.length) {
      emit('apply-edit', { instruction: msg, reply: j.message || '', actions: j.actions })
    }
  } catch (e) {
    messages.value.push({
      role: 'assistant',
      text: '⚠️ 后端不可达：' + (e.message || e),
    })
  } finally {
    sending.value = false
  }
}
</script>

<style scoped>
/* 悬浮按钮 */
.fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  background: #4f46e5;
  color: #fff;
  font-size: 24px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 9999;
}
.fab:hover { background: #4338ca; }

/* 面板 */
.panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 360px;
  height: 520px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  z-index: 9999;
  font-size: 14px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: #f7f7f9;
  border-bottom: 1px solid #eee;
  gap: 8px;
}
.head .title { font-weight: 600; }
.head .spacer { flex: 1; }
.head .x {
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: #666;
}
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}
.badge.dsh { background: #dcfce7; color: #15803d; }
.badge.stub { background: #fef3c7; color: #b45309; }
.badge.offline { background: #fee2e2; color: #b91c1c; }

/* 消息区 */
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  background: #fafafa;
}
.empty {
  text-align: center;
  color: #888;
  padding: 24px 8px;
  line-height: 1.8;
  font-size: 13px;
}
.empty code {
  background: #eee;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
}
.msg {
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
}
.msg.user { align-items: flex-end; }
.msg.user .bubble {
  background: #4f46e5;
  color: #fff;
  border-radius: 12px 12px 2px 12px;
}
.msg.assistant { align-items: flex-start; }
.msg.assistant .bubble {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 12px 12px 12px 2px;
}
.bubble {
  max-width: 85%;
  padding: 8px 12px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}
.bubble.pending {
  display: flex;
  gap: 4px;
  padding: 12px 16px;
}
.bubble.pending .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #aaa;
  animation: bounce 1.4s infinite ease-in-out both;
}
.bubble.pending .dot:nth-child(2) { animation-delay: 0.16s; }
.bubble.pending .dot:nth-child(3) { animation-delay: 0.32s; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}
.actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.action-tag {
  background: #ede9fe;
  color: #6d28d9;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
}

/* 输入区 */
.input {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #eee;
  background: #fff;
}
.input input {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  font-size: 13px;
  outline: none;
}
.input input:focus { border-color: #4f46e5; }
.input button {
  padding: 0 16px;
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.input button:disabled {
  background: #c7d2fe;
  cursor: not-allowed;
}
</style>
