'use strict';

export default {
  routes: [
    {
      method: 'GET',
      path: '/conversations/mine',
      handler: 'conversation.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/conversations/messages/mine',
      handler: 'conversation.myMessages',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/conversations/:threadId/messages',
      handler: 'conversation.messagesByThread',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/conversations/upsert',
      handler: 'conversation.upsert',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/conversations/message',
      handler: 'conversation.sendMessage',
      config: { auth: { scope: [] } },
    },
    {
      method: 'DELETE',
      path: '/conversations/:threadId',
      handler: 'conversation.deleteByThreadId',
      config: { auth: { scope: [] } },
    },
  ],
};


