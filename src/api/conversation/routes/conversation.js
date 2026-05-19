'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/conversations/mine',
      handler: 'conversation.mine',
      config: { auth: true },
    },
    {
      method: 'GET',
      path: '/conversations/messages/mine',
      handler: 'conversation.myMessages',
      config: { auth: true },
    },
    {
      method: 'GET',
      path: '/conversations/:threadId/messages',
      handler: 'conversation.messagesByThread',
      config: { auth: true },
    },
    {
      method: 'POST',
      path: '/conversations/upsert',
      handler: 'conversation.upsert',
      config: { auth: true },
    },
    {
      method: 'POST',
      path: '/conversations/message',
      handler: 'conversation.sendMessage',
      config: { auth: true },
    },
  ],
};
