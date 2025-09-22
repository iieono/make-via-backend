import { logger } from '@/utils/logger';
import { supabase } from '@/services/supabase';
import { config } from '@/config/config';

interface EmailTemplate {
  subject: string;
  htmlContent: string;
  textContent: string;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  templateName?: string;
  scheduleFor?: Date;
}

interface QueueEmailOptions {
  userId: string;
  emailType: string;
  templateName: string;
  recipientEmail: string;
  contentData?: Record<string, any>;
  scheduleFor?: Date;
}

export class EmailService {
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY || '';
    this.fromEmail = process.env.FROM_EMAIL || 'noreply@makevia.com';
    this.fromName = process.env.FROM_NAME || 'MakeVia';
  }

  /**
   * Queue an email for sending
   */
  async queueEmail(options: QueueEmailOptions): Promise<void> {
    const { userId, emailType, templateName, recipientEmail, contentData, scheduleFor } = options;

    try {
      const template = this.getEmailTemplate(templateName, contentData || {});
      
      await supabase.serviceClient
        .from('email_queue')
        .insert({
          user_id: userId,
          email_type: emailType,
          template_name: templateName,
          recipient_email: recipientEmail,
          subject: template.subject,
          content_data: contentData || {},
          status: 'pending',
          scheduled_for: scheduleFor?.toISOString() || new Date().toISOString(),
        });

      logger.info('Email queued successfully', {
        userId,
        emailType,
        templateName,
        recipientEmail,
        scheduledFor: scheduleFor
      });
    } catch (error) {
      logger.error('Failed to queue email', { error, options });
      throw error;
    }
  }

  /**
   * Process pending emails from the queue
   */
  async processPendingEmails(): Promise<void> {
    try {
      // Get pending emails that are scheduled to be sent
      const { data: pendingEmails, error } = await supabase.serviceClient
        .from('email_queue')
        .select('*')
        .eq('status', 'pending')
        .lte('scheduled_for', new Date().toISOString())
        .lt('retry_count', supabase.raw('max_retries'))
        .order('scheduled_for')
        .limit(50);

      if (error) {
        logger.error('Failed to fetch pending emails', { error });
        return;
      }

      if (!pendingEmails || pendingEmails.length === 0) {
        return;
      }

      logger.info(`Processing ${pendingEmails.length} pending emails`);

      for (const email of pendingEmails) {
        try {
          // Mark as sending
          await supabase.serviceClient
            .from('email_queue')
            .update({ 
              status: 'sending',
              updated_at: new Date().toISOString()
            })
            .eq('id', email.id);

          // Generate content from template
          const template = this.getEmailTemplate(email.template_name, email.content_data);

          // Send email
          await this.sendEmail({
            to: email.recipient_email,
            subject: template.subject,
            htmlContent: template.htmlContent,
            textContent: template.textContent,
            templateName: email.template_name
          });

          // Mark as sent
          await supabase.serviceClient
            .from('email_queue')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', email.id);

          logger.info('Email sent successfully', {
            emailId: email.id,
            templateName: email.template_name,
            recipient: email.recipient_email
          });

        } catch (error) {
          // Mark as failed and increment retry count
          await supabase.serviceClient
            .from('email_queue')
            .update({
              status: 'pending', // Reset to pending for retry
              retry_count: email.retry_count + 1,
              error_message: error instanceof Error ? error.message : 'Unknown error',
              updated_at: new Date().toISOString()
            })
            .eq('id', email.id);

          logger.error('Failed to send email', {
            emailId: email.id,
            error: error instanceof Error ? error.message : 'Unknown error',
            retryCount: email.retry_count + 1
          });
        }
      }
    } catch (error) {
      logger.error('Failed to process pending emails', { error });
    }
  }

  /**
   * Send email immediately (internal method)
   */
  private async sendEmail(options: SendEmailOptions): Promise<void> {
    // Use Resend if available, fallback to console log in development
    if (this.apiKey && this.apiKey.startsWith('re_')) {
      await this.sendWithResend(options);
    } else {
      // Development mode - log email instead of sending
      logger.info('Email would be sent (development mode)', {
        to: options.to,
        subject: options.subject,
        template: options.templateName
      });
      console.log('=== EMAIL ===');
      console.log(`To: ${options.to}`);
      console.log(`Subject: ${options.subject}`);
      console.log(`Content: ${options.textContent || options.htmlContent}`);
      console.log('=============');
    }
  }

  /**
   * Send email using Resend
   */
  private async sendWithResend(options: SendEmailOptions): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: [options.to],
        subject: options.subject,
        html: options.htmlContent,
        text: options.textContent,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorData}`);
    }
  }

  /**
   * Get email template with data substitution
   */
  private getEmailTemplate(templateName: string, data: Record<string, any>): EmailTemplate {
    const templates: Record<string, (data: Record<string, any>) => EmailTemplate> = {
      subscription_payment_failed_day1: (data) => ({
        subject: 'Payment Failed - Please Update Your Card',
        htmlContent: `
          <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Payment Update Needed</h1>
            </div>
            
            <div style="padding: 40px 20px; background: white;">
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                Hi ${data.userName || 'there'},
              </p>
              
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                We had trouble processing your payment for your <strong>${data.planName}</strong> subscription to MakeVia. 
                This could be due to an expired card, insufficient funds, or a change in your billing information.
              </p>
              
              <div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 30px 0;">
                <h3 style="margin: 0 0 10px 0; color: #92400e; font-size: 16px;">What happens next?</h3>
                <p style="margin: 0; color: #92400e; font-size: 14px;">
                  Your subscription is currently past due. Please update your payment method within the next 2 days to avoid service interruption.
                </p>
              </div>
              
              <div style="text-align: center; margin: 40px 0;">
                <a href="${data.updatePaymentUrl}" style="background: #667eea; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                  Update Payment Method
                </a>
              </div>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 30px;">
                If you have any questions or need help, please reply to this email or contact our support team.
              </p>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                The MakeVia Team
              </p>
            </div>
          </div>
        `,
        textContent: `Hi ${data.userName || 'there'},\n\nWe had trouble processing your payment for your ${data.planName} subscription to MakeVia. Please update your payment method within the next 2 days to avoid service interruption.\n\nUpdate your payment method: ${data.updatePaymentUrl}\n\nBest regards,\nThe MakeVia Team`
      }),

      subscription_payment_failed_day2: (data) => ({
        subject: 'Reminder: Fix Your Payment Issue',
        htmlContent: `
          <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Payment Reminder</h1>
            </div>
            
            <div style="padding: 40px 20px; background: white;">
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                Hi ${data.userName || 'there'},
              </p>
              
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                This is a friendly reminder that your <strong>${data.planName}</strong> subscription payment is still pending. 
                We sent you an email yesterday, but we wanted to make sure you didn't miss it.
              </p>
              
              <div style="background: #fee2e2; border: 1px solid #fca5a5; border-radius: 8px; padding: 20px; margin: 30px 0;">
                <h3 style="margin: 0 0 10px 0; color: #dc2626; font-size: 16px;">Action Required</h3>
                <p style="margin: 0; color: #dc2626; font-size: 14px;">
                  Please update your payment method within the next 24 hours to avoid subscription cancellation.
                </p>
              </div>
              
              <div style="text-align: center; margin: 40px 0;">
                <a href="${data.updatePaymentUrl}" style="background: #dc2626; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">
                  Fix Payment Issue Now
                </a>
              </div>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 30px;">
                We really don't want to see you go! If you're experiencing issues, please don't hesitate to reach out to our support team.
              </p>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                The MakeVia Team
              </p>
            </div>
          </div>
        `,
        textContent: `Hi ${data.userName || 'there'},\n\nThis is a reminder that your ${data.planName} subscription payment is still pending. Please update your payment method within the next 24 hours to avoid subscription cancellation.\n\nFix payment issue: ${data.updatePaymentUrl}\n\nBest regards,\nThe MakeVia Team`
      }),

      subscription_payment_failed_day3: (data) => ({
        subject: 'Final Notice: Subscription Will Be Cancelled',
        htmlContent: `
          <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 40px 20px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Final Notice</h1>
            </div>
            
            <div style="padding: 40px 20px; background: white;">
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                Hi ${data.userName || 'there'},
              </p>
              
              <p style="font-size: 16px; line-height: 1.6; color: #374151; margin-bottom: 20px;">
                We've tried to process your payment for the <strong>${data.planName}</strong> subscription multiple times without success. 
                Unfortunately, we'll need to cancel your subscription within the next few hours if payment isn't received.
              </p>
              
              <div style="background: #fee2e2; border: 2px solid #dc2626; border-radius: 8px; padding: 20px; margin: 30px 0;">
                <h3 style="margin: 0 0 10px 0; color: #dc2626; font-size: 16px;">⚠️ Cancellation Warning</h3>
                <p style="margin: 0; color: #dc2626; font-size: 14px;">
                  Your subscription will be automatically cancelled if payment is not received within a few hours.
                </p>
              </div>
              
              <div style="text-align: center; margin: 40px 0;">
                <a href="${data.updatePaymentUrl}" style="background: #dc2626; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; font-size: 16px;">
                  Save My Subscription
                </a>
              </div>
              
              <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; margin: 30px 0;">
                <h3 style="margin: 0 0 10px 0; color: #374151; font-size: 16px;">What you'll lose:</h3>
                <ul style="margin: 0; color: #6b7280; font-size: 14px; padding-left: 20px;">
                  <li>Access to premium features</li>
                  <li>Increased credit allocation</li>
                  <li>Priority support</li>
                  <li>Advanced AI models</li>
                </ul>
              </div>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 30px;">
                We hate to see you go! If you need any assistance or have questions about your subscription, 
                please contact our support team immediately.
              </p>
              
              <p style="font-size: 14px; line-height: 1.6; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                The MakeVia Team
              </p>
            </div>
          </div>
        `,
        textContent: `Hi ${data.userName || 'there'},\n\nFINAL NOTICE: Your ${data.planName} subscription will be cancelled within a few hours if payment is not received.\n\nSave your subscription: ${data.updatePaymentUrl}\n\nBest regards,\nThe MakeVia Team`
      })
    };

    if (!templates[templateName]) {
      throw new Error(`Email template '${templateName}' not found`);
    }

    return templates[templateName](data);
  }

  /**
   * Schedule subscription failure email sequence
   */
  async scheduleSubscriptionFailureEmails(
    userId: string,
    userEmail: string,
    userName: string,
    planName: string,
    stripeCustomerId: string
  ): Promise<void> {
    const now = new Date();
    const updatePaymentUrl = `${config.urls.frontend}/subscription/update-payment?customer_id=${stripeCustomerId}`;

    const emailData = {
      userName,
      planName,
      updatePaymentUrl
    };

    // Schedule Day 1 email (immediate)
    await this.queueEmail({
      userId,
      emailType: 'subscription_payment_failed',
      templateName: 'subscription_payment_failed_day1',
      recipientEmail: userEmail,
      contentData: emailData,
      scheduleFor: now
    });

    // Schedule Day 2 email (24 hours later)
    const day2Date = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await this.queueEmail({
      userId,
      emailType: 'subscription_payment_failed',
      templateName: 'subscription_payment_failed_day2',
      recipientEmail: userEmail,
      contentData: emailData,
      scheduleFor: day2Date
    });

    // Schedule Day 3 email (48 hours later)
    const day3Date = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    await this.queueEmail({
      userId,
      emailType: 'subscription_payment_failed',
      templateName: 'subscription_payment_failed_day3',
      recipientEmail: userEmail,
      contentData: emailData,
      scheduleFor: day3Date
    });

    logger.info('Subscription failure email sequence scheduled', {
      userId,
      userEmail,
      planName
    });
  }

  /**
   * Cancel scheduled emails (when payment succeeds)
   */
  async cancelScheduledEmails(userId: string, emailType: string): Promise<void> {
    await supabase.serviceClient
      .from('email_queue')
      .update({ 
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('email_type', emailType)
      .eq('status', 'pending');

    logger.info('Cancelled scheduled emails', { userId, emailType });
  }
}

export const emailService = new EmailService();