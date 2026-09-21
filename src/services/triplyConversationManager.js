const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const engine = require('../orchestration/engine');

class TriplyConversationManager {

  // ── MAIN ENTRY POINT ──────────────────────────────────────────────────────
  // Called instead of orchestrationEngine.orchestrate() for Triply agencies
  async handle(prompt, agencyId, context = {}) {
    const { conversationHistory = [], previousParams = null } = context;
    const travelerNumber = context.phone || null;

    logger.info('[Triply] Incoming request', { agencyId, travelerNumber });

    try {
      // 1. Find or create conversation
      const conversation = await this._getOrCreateConversation(
        agencyId, travelerNumber, previousParams
      );

      // 2. Send waiting message if not already sent
      if (!conversation.waiting_message_sent) {
        await this._sendWaitingMessage(travelerNumber, agencyId, context);
        await this._markWaitingMessageSent(conversation.id);
      }

      // 3. Update state to building
      await this._updateState(conversation.id, 'building');

      // 4. Run your existing engine — completely unchanged
      const result = await orchestrationEngine.orchestrate(
        prompt, agencyId, {
          ...context,
          conversationHistory,
          previousParams,
        }
      );

      // 5. Save the draft
      const newVersion = (conversation.version || 0) + 1;
      await this._saveDraft({
        conversationId:  conversation.id,
        version:         newVersion,
        packages:        result.packages,
        tripParams:      result.tripParams,
        builtBy:         'bodrless',
        agentInstruction: null,
      });

      // 6. Update conversation with draft and set to awaiting approval
      await this._updateConversation(conversation.id, {
        state:               'awaiting_approval',
        current_draft:       result,
        trip_params:         result.tripParams,
        conversation_history: result.conversationHistory || conversationHistory,
        version:             newVersion,
        updated_at:          new Date().toISOString(),
      });

      // 7. Notify Triply that a new draft is ready
      await this._notifyTriply(agencyId, conversation.id, newVersion);

      logger.info('[Triply] Draft ready — awaiting agent approval', {
        conversationId: conversation.id,
        version: newVersion,
        packages: result.packages.length,
      });

      // 8. Return to caller — do NOT send to traveler yet
      return {
        ...result,
        triply: {
          conversationId: conversation.id,
          state:          'awaiting_approval',
          version:        newVersion,
        },
      };

    } catch (err) {
      logger.error('[Triply] ConversationManager failed', {
        agencyId, error: err.message, stack: err.stack,
      });
      throw err;
    }
  }

  // ── AGENT APPROVES ────────────────────────────────────────────────────────
  async approve(conversationId, agencyId) {
    const conversation = await this._getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');
    if (conversation.state !== 'awaiting_approval') {
      throw new Error(`Cannot approve — current state is ${conversation.state}`);
    }

    // Log the action
    await this._logAction(conversationId, agencyId, 'approved', null);

    // Update state to delivering
    await this._updateState(conversationId, 'delivering');

    // Deliver to traveler
    await this._deliverToTraveler(conversation);

    // Mark complete
    await this._updateState(conversationId, 'complete');

    logger.info('[Triply] Approved and delivered', { conversationId });
    return { success: true, conversationId, state: 'complete' };
  }

  // ── AGENT EDITS AND APPROVES ──────────────────────────────────────────────
  async edit(conversationId, agencyId, modifiedDraft) {
    const conversation = await this._getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');

    // Log the action
    await this._logAction(conversationId, agencyId, 'edited', { modifiedDraft });

    // Save modified version
    const newVersion = (conversation.version || 0) + 1;
    await this._saveDraft({
      conversationId,
      version:         newVersion,
      packages:        modifiedDraft.packages || conversation.current_draft.packages,
      tripParams:      conversation.trip_params,
      builtBy:         'agent_edit',
      agentInstruction: null,
    });

    await this._updateState(conversationId, 'delivering');

    // Deliver modified version to traveler
    await this._deliverToTraveler({
      ...conversation,
      current_draft: modifiedDraft,
    });

    await this._updateState(conversationId, 'complete');

    logger.info('[Triply] Edited and delivered', { conversationId });
    return { success: true, conversationId, state: 'complete' };
  }

  // ── AGENT REQUESTS REBUILD ────────────────────────────────────────────────
  async rebuild(conversationId, agencyId, instruction) {
    const conversation = await this._getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');

    // Log the action
    await this._logAction(conversationId, agencyId, 'rebuild_requested', { instruction });

    // Update state to building
    await this._updateState(conversationId, 'building');

    // Run engine again with the instruction appended to the original prompt
    const originalParams = conversation.trip_params || {};
    const result = await orchestrationEngine.orchestrate(
      instruction, agencyId, {
        previousParams:      originalParams,
        conversationHistory: conversation.conversation_history || [],
      }
    );

    // Save new draft version
    const newVersion = (conversation.version || 0) + 1;
    await this._saveDraft({
      conversationId,
      version:          newVersion,
      packages:         result.packages,
      tripParams:       result.tripParams,
      builtBy:          'bodrless',
      agentInstruction: instruction,
    });

    // Update conversation
    await this._updateConversation(conversationId, {
      state:         'awaiting_approval',
      current_draft: result,
      trip_params:   result.tripParams,
      version:       newVersion,
      updated_at:    new Date().toISOString(),
    });

    // Notify Triply new draft is ready
    await this._notifyTriply(agencyId, conversationId, newVersion);

    logger.info('[Triply] Rebuild complete — awaiting approval', {
      conversationId, version: newVersion,
    });

    return {
      success:        true,
      conversationId,
      state:          'awaiting_approval',
      version:        newVersion,
      packagesCount:  result.packages.length,
    };
  }

  // ── GET CURRENT DRAFT ─────────────────────────────────────────────────────
  // This is what Triply calls to display the itinerary in their dashboard
  async getDraft(conversationId) {
    const conversation = await this._getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');

    return {
      conversationId,
      state:       conversation.state,
      version:     conversation.version,
      draft:       conversation.current_draft,
      tripParams:  conversation.trip_params,
      updatedAt:   conversation.updated_at,
    };
  }

  // ── INTERNAL HELPERS ──────────────────────────────────────────────────────

  async _getOrCreateConversation(agencyId, travelerNumber, previousParams) {
    // Look for an active conversation for this traveler and agency
    if (travelerNumber) {
      const { data: existing } = await supabase
        .from('triply_conversations')
        .select('*')
        .eq('agency_id', agencyId)
        .eq('traveler_number', travelerNumber)
        .not('state', 'eq', 'complete')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (existing) return existing;
    }

    // Get the partner_id for Triply
    const { data: partner } = await supabase
      .from('partners')
      .select('id')
      .eq('slug', 'triply')
      .single();

    // Create a new conversation
    const { data: created, error } = await supabase
      .from('triply_conversations')
      .insert({
        id:             uuidv4(),
        agency_id:      agencyId,
        partner_id:     partner?.id || null,
        traveler_number: travelerNumber,
        state:          'building',
        trip_params:    previousParams || {},
        created_at:     new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create conversation: ${error.message}`);
    return created;
  }

  async _getConversation(conversationId) {
    const { data, error } = await supabase
      .from('triply_conversations')
      .select('*')
      .eq('id', conversationId)
      .single();

    if (error) throw new Error(`Failed to get conversation: ${error.message}`);
    return data;
  }

  async _updateState(conversationId, state) {
    const { error } = await supabase
      .from('triply_conversations')
      .update({ state, updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    if (error) throw new Error(`Failed to update state: ${error.message}`);
  }

  async _updateConversation(conversationId, updates) {
    const { error } = await supabase
      .from('triply_conversations')
      .update(updates)
      .eq('id', conversationId);

    if (error) throw new Error(`Failed to update conversation: ${error.message}`);
  }

  async _saveDraft({ conversationId, version, packages, tripParams, builtBy, agentInstruction }) {
    const { error } = await supabase
      .from('triply_drafts')
      .insert({
        id:               uuidv4(),
        conversation_id:  conversationId,
        version,
        packages,
        trip_params:      tripParams,
        built_by:         builtBy,
        agent_instruction: agentInstruction,
        created_at:       new Date().toISOString(),
      });

    if (error) throw new Error(`Failed to save draft: ${error.message}`);
  }

  async _logAction(conversationId, agencyId, action, payload) {
    const { error } = await supabase
      .from('triply_agent_actions')
      .insert({
        id:              uuidv4(),
        conversation_id: conversationId,
        agency_id:       agencyId,
        action,
        payload,
        created_at:      new Date().toISOString(),
      });

    if (error) logger.warn('[Triply] Failed to log action', { error: error.message });
  }

  async _markWaitingMessageSent(conversationId) {
    await supabase
      .from('triply_conversations')
      .update({ waiting_message_sent: true })
      .eq('id', conversationId);
  }

  async _sendWaitingMessage(travelerNumber, agencyId, context) {
    // This hooks into your existing WhatsApp sending logic
    // Replace this with however you currently send a WhatsApp message
    const message = "We've got your request! We're putting together your trip and will have something for you shortly.";

    try {
      if (context.sendWhatsApp && travelerNumber) {
        await context.sendWhatsApp(travelerNumber, message);
      }
      logger.info('[Triply] Waiting message sent', { travelerNumber });
    } catch (err) {
      logger.warn('[Triply] Failed to send waiting message', { error: err.message });
    }
  }

  async _deliverToTraveler(conversation) {
    // This is where the approved package goes back to the traveler
    // Hook into your existing WhatsApp sending logic
    const draft    = conversation.current_draft;
    const packages = draft?.packages || [];

    if (!packages.length) {
      logger.warn('[Triply] No packages to deliver', { conversationId: conversation.id });
      return;
    }

    // Format the package as a message
    // Replace this with your existing package formatting logic
    const message = this._formatPackageMessage(packages);

    try {
      // Hook into your existing send function here
      logger.info('[Triply] Delivered to traveler', {
        conversationId:  conversation.id,
        travelerNumber:  conversation.traveler_number,
        packagesCount:   packages.length,
      });
    } catch (err) {
      logger.error('[Triply] Delivery failed', { error: err.message });
      throw err;
    }
  }

  async _notifyTriply(agencyId, conversationId, version) {
    // Get the Triply webhook URL from partners table
    try {
      const { data: partner } = await supabase
        .from('partners')
        .select('webhook_url')
        .eq('slug', 'triply')
        .single();

      if (!partner?.webhook_url) {
        logger.info('[Triply] No webhook URL set yet — skipping notification');
        return;
      }

      await fetch(partner.webhook_url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event:          'itinerary.ready',
          conversation_id: conversationId,
          agency_id:      agencyId,
          version,
          timestamp:      new Date().toISOString(),
        }),
      });

      logger.info('[Triply] Notified Triply of new draft', { conversationId, version });
    } catch (err) {
      logger.warn('[Triply] Failed to notify Triply', { error: err.message });
    }
  }

  _formatPackageMessage(packages) {
    // Placeholder — replace with your existing package formatting
    return `Your trip package is ready. ${packages.length} option${packages.length > 1 ? 's' : ''} available.`;
  }
}

module.exports = new TriplyConversationManager();