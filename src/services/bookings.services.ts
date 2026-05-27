import type { Booking, Voucher_Approver } from "@prisma/client";
import prisma from "../db/DB.ts";
import type { Booking_Data } from "../types/booking/bookingData.ts";
import type { searchAndFilterBookingData } from "../validators/data-validators/booking/searchAndFilterBooking.ts";
import type { updateBookingStatusBodyData } from "../validators/data-validators/booking/updateBookingStatusBody.ts";
import type { updatePaymentStatusBodyData } from "../validators/data-validators/booking/updatePaymentStatusBody.ts";
import { NotFoundError, InternalServerError, ConflictError } from "../utils/errors/customErrors.ts";
import { appendToSheet } from "./googleSheets.services.ts";
import { escapeCSVValue, formatAmount, formatDate, formatDateTime } from "../utils/csv/csvHelpers.ts";
import type { getCalendarBookingsData } from "../validators/data-validators/booking/getBookingAvailability.ts";
import { getAdminContactsService } from "./settings.services.ts";
import { generateVoucherService } from "./automation.services.ts";
import { sendVoucherEmailService } from "./email.services.ts";
import { sendVoucherWhatsAppService } from "./whatsapp.services.ts";
import { syncAvailabilityOnCreate, syncAvailabilityOnDelete } from "./availabilitySheet.services.ts";

// Service to check if a booking exist
export async function checkIfBookingExistService(bookingId: number): Promise<Booking | null> {
    try {
        const booking = await prisma.booking.findUnique({
            where: {
                id: bookingId
            }
        });

        return booking;
    }
    catch (error) {
        console.error(`Error checking booking existence: ${error}`);
        throw new InternalServerError("Failed to verify booking existence");
    }
}

// Service to check if a villa is available during a duration
export async function checkVillaAvailabilityService({ villaId, checkInDate, checkOutDate }: { villaId: number, checkInDate: Date, checkOutDate: Date }): Promise<boolean> {
    try {
        const villa = await prisma.villa.findUnique({
            where: {
                id: villaId
            },
            include: {
                bookings: {
                    where: {
                        bookingStatus: {
                            in: ['CONFIRMED', 'CHECKED_IN']
                        }
                    },
                    select: {
                        checkIn: true,
                        checkOut: true,
                        bookingStatus: true
                    }
                }
            }
        });

        if (!villa) {
            return false;
        }

        for (const booking of villa.bookings) {
            const hasOverlap = (checkInDate < booking.checkOut) && (checkOutDate > booking.checkIn);

            if (hasOverlap) {
                return false;
            }
        }

        return true;

    }
    catch (error) {
        console.error(`Error checking villa availability: ${error}`);
        throw new InternalServerError("Failed to check villa availability");
    }
};

// Service to check if a villa is available during a duration While Updating a Booking
export async function checkVillaAvailabilityForUpdateService({ villaId, checkInDate, checkOutDate, excludeBookingId }: { villaId: number, checkInDate: Date, checkOutDate: Date, excludeBookingId: number }): Promise<boolean> {
    try {
        const villa = await prisma.villa.findUnique({
            where: { id: villaId },
            include: {
                bookings: {
                    where: {
                        bookingStatus: {
                            in: ['CONFIRMED', 'CHECKED_IN']
                        },
                        id: {
                            not: excludeBookingId
                        }
                    },
                    select: {
                        checkIn: true,
                        checkOut: true,
                        bookingStatus: true
                    }
                }
            }
        });

        if (!villa) {
            return false;
        }

        for (const booking of villa.bookings) {
            const hasOverlap = (checkInDate < booking.checkOut) && (checkOutDate > booking.checkIn);
            if (hasOverlap) {
                return false;
            }
        }

        return true;
    }
    catch (error) {
        console.error(`Error checking villa availability for update: ${error}`);
        throw new InternalServerError("Failed to check villa availability for update");
    }
}

// Service to Add a Booking
export async function addBookingService(formData: Booking_Data): Promise<Booking> {
    try {
        const booking = await prisma.booking.create({
            data: formData
        });

        return booking;
    }
    catch (error) {
        console.error(`Error creating booking: ${error}`);
        throw new InternalServerError("Failed to create booking");
    }
};

// Service for Transaction-based availability check
export async function checkVillaAvailabilityWithTx(tx: any, villaId: number, checkIn: Date, checkOut: Date): Promise<boolean> {
    const villa = await tx.villa.findUnique({
        where: { id: villaId },
        include: {
            bookings: {
                where: {
                    bookingStatus: { in: ['CONFIRMED', 'CHECKED_IN'] }
                },
                select: {
                    checkIn: true,
                    checkOut: true
                }
            }
        }
    });

    if (!villa) {
        return false;
    }

    for (const booking of villa.bookings) {
        const hasOverlap = (checkIn < booking.checkOut) && (checkOut > booking.checkIn);
        if (hasOverlap) {
            return false;
        }
    }

    return true;
}

// Service to Create Booking with Google Sheets Sync
export async function createBookingWithSheetSync(bookingData: Booking_Data, villaName: string): Promise<Booking> {
    try {
        const booking = await prisma.$transaction(async (tx) => {
            const isAvailable = await checkVillaAvailabilityWithTx(
                tx,
                bookingData.villaId,
                bookingData.checkIn,
                bookingData.checkOut
            );

            if (!isAvailable) {
                throw new ConflictError("Villa is not available for the selected dates");
            };

            const newBooking = await tx.booking.create({
                data: bookingData
            });

            const sheetsResult = await appendToSheet(newBooking, villaName);

            if (!sheetsResult.success) {
                throw new Error(`Failed to sync with Google Sheets: ${sheetsResult.error}`);
            };

            return newBooking;
        }, {
            timeout: 15000
        });

        // Sync availability calendar (non-blocking)
        syncAvailabilityOnCreate(villaName, booking.checkIn, booking.checkOut)
            .catch(err => console.error("Availability sync failed:", err));

        return booking;
    }
    catch (error: any) {
        console.error(`Error creating booking with Sheets sync: ${error}`);
        throw new InternalServerError(error.message || "Failed to create booking");
    };
};

// Service to Update a Booking
export async function updateBookingService(bookingId: number, updateData: any): Promise<Booking> {
    try {
        const updatedBooking = await prisma.booking.update({
            where: {
                id: bookingId
            },
            data: updateData
        });

        return updatedBooking;
    }
    catch (error) {
        if (error.code === 'P2025') {
            throw new NotFoundError("Booking not found");
        }

        console.error(`Error updating booking: ${error}`);
        throw new InternalServerError("Failed to update booking");
    }
}

// Service to Update a Booking Status
export async function updateBookingStatusService({ bookingId, updatedData }: { bookingId: number, updatedData: updateBookingStatusBodyData }): Promise<Booking | null> {
    try {
        const updatedBooking = await prisma.booking.update({
            where: {
                id: bookingId
            },
            data: updatedData
        });

        return updatedBooking;
    }
    catch (error) {
        // Check if booking doesn't exist
        if (error.code === 'P2025') {
            throw new NotFoundError("Booking not found");
        }

        console.error(`Error updating booking status: ${error}`);
        throw new InternalServerError("Failed to update booking status");
    }
}

// Service to Update a Payment Status
export async function updatePaymentStatusService({ bookingId, updatedData }: { bookingId: number, updatedData: updatePaymentStatusBodyData }): Promise<Booking | null> {
    try {
        const updatedBooking = await prisma.booking.update({
            where: {
                id: bookingId
            },
            data: updatedData
        });

        return updatedBooking;
    }
    catch (error) {
        if (error.code === 'P2025') {
            throw new NotFoundError("Booking not found");
        }

        console.error(`Error updating payment status: ${error}`);
        throw new InternalServerError("Failed to update payment status");
    }
}

// Service to Delete a Booking
export async function deleteBookingService(bookingId: number): Promise<Booking> {
    try {
        // Get booking with villa name before deleting
        const booking = await prisma.booking.findUnique({
            where: { id: bookingId },
            include: { villa: true }
        });

        if (!booking) {
            throw new NotFoundError("Booking not found");
        }

        const deletedBooking = await prisma.booking.delete({
            where: { id: bookingId }
        });

        // Sync availability calendar (non-blocking)
        syncAvailabilityOnDelete(booking.villa.name, booking.checkIn, booking.checkOut)
            .catch(err => console.error("Availability sync failed:", err));

        return deletedBooking;
    }
    catch (error: any) {
        if (error.code === 'P2025') {
            throw new NotFoundError("Booking not found");
        }

        console.error(`Error deleting booking: ${error}`);
        throw new InternalServerError("Failed to delete booking");
    }
}

// Service to get All Bookings
export async function getAllBookingsService(): Promise<Booking[] | null> {
    try {
        const bookings = await prisma.booking.findMany({
            include: {
                villa: true
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        return bookings;
    }
    catch (error) {
        console.error(`Error fetching all bookings: ${error}`);
        throw new InternalServerError("Failed to fetch bookings");
    }
}

// Service to get A Booking
export async function getABookingService(bookingId: number): Promise<Booking | null> {
    try {
        const booking = await prisma.booking.findUnique({
            where: {
                id: bookingId
            },
            include: {
                villa: true
            }
        });

        return booking;
    }
    catch (error) {
        console.error(`Error fetching booking: ${error}`);
        throw new InternalServerError("Failed to fetch booking details");
    }
}

// Service to Search and Filter Bookings
export async function searchAndFilterBookingsService(validatedData: searchAndFilterBookingData): Promise<any> {
    try {
        let where: any = {};

        if (validatedData.searchText && validatedData.searchText.trim()) {
            where.OR = [
                {
                    guestName: {
                        contains: validatedData.searchText
                    }
                },
                {
                    guestPhone: {
                        contains: validatedData.searchText
                    }
                },
                {
                    villa: {
                        name: {
                            contains: validatedData.searchText
                        }
                    }
                }
            ];
        }

        if (validatedData.bookingStatus && validatedData.bookingStatus.trim()) {
            where.bookingStatus = validatedData.bookingStatus;
        };

        if (validatedData.paymentStatus && validatedData.paymentStatus.trim()) {
            where.paymentStatus = validatedData.paymentStatus;
        };

        if (validatedData.checkInDate && validatedData.checkInDate.trim()) {
            const [year, month, day] = validatedData.checkInDate.split('-').map(Number) as [number, number, number];
            const startOfDay = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
            const endOfDay = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

            where.checkIn = {
                gte: startOfDay,
                lte: endOfDay
            };
        };

        const { page, limit } = validatedData;

        if (page !== undefined && limit !== undefined) {
            const skip = (page - 1) * limit;

            const [bookings, totalBookings] = await prisma.$transaction([
                prisma.booking.findMany({
                    where: where,
                    include: {
                        villa: true
                    },
                    orderBy: {
                        createdAt: 'desc'
                    },
                    skip: skip,
                    take: limit
                }),
                prisma.booking.count({
                    where: where
                })
            ]);

            const totalPages = Math.ceil(totalBookings / limit);

            return {
                bookings,
                pagination: {
                    totalBookings,
                    totalPages,
                    currentPage: page,
                    limit
                }
            };
        }

        const bookings = await prisma.booking.findMany({
            where: where,
            include: {
                villa: true
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        return bookings;
    }
    catch (error) {
        console.error(`Error searching and filtering bookings: ${error}`);
        throw new InternalServerError("Failed to search bookings");
    };
};

// Service to Format Bookings for CSV
export async function formatBookingsForCSV(bookings: any[]) {
    try {
        return bookings.map(booking => ({
            'Booking ID': escapeCSVValue(booking.id),
            'Guest Name': escapeCSVValue(booking.guestName),
            'Guest Email': escapeCSVValue(booking.guestEmail || ''),
            'Guest Phone': escapeCSVValue(booking.guestPhone),
            'Alternate Phone': escapeCSVValue(booking.alternatePhone || ''),
            'Villa Name': escapeCSVValue(booking.villa.name),
            'Villa Location': escapeCSVValue(booking.villa.location),
            'Check-in Date': escapeCSVValue(formatDate(booking.checkIn)),
            'Check-out Date': escapeCSVValue(formatDate(booking.checkOut)),
            'Number of Guests': escapeCSVValue(booking.totalGuests),
            'Number of Nights': escapeCSVValue(booking.numberOfNights),
            'Booking Status': escapeCSVValue(booking.bookingStatus),
            'Payment Status': escapeCSVValue(booking.paymentStatus),
            'Custom Price': escapeCSVValue(formatAmount(booking.customPrice)),
            'Extra Charges': escapeCSVValue(formatAmount(booking.extraPersonCharge)),
            'Discount': escapeCSVValue(formatAmount(booking.discount)),
            'Tax Amount': escapeCSVValue(formatAmount(booking.totalTax)),
            'Total Amount': escapeCSVValue(formatAmount(booking.totalPayableAmount)),
            'Advance Paid': escapeCSVValue(formatAmount(booking.advancePaid)),
            'Due Amount': escapeCSVValue(formatAmount(booking.dueAmount)),
            'Special Requests': escapeCSVValue(booking.specialRequest || ''),
            'Created Date': escapeCSVValue(formatDateTime(booking.createdAt)),
            'Updated Date': escapeCSVValue(formatDateTime(booking.updatedAt))
        }));
    }
    catch (error) {
        console.error(`Error formatting bookings for CSV: ${error}`);
        throw new InternalServerError("Failed to format bookings data");
    }
}

// Service to Get Calendar Bookings
export async function getCalendarBookingsService(validatedData: getCalendarBookingsData) {
    try {
        const { villaId, month, year } = validatedData;
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);

        let where: any = {
            bookingStatus: {
                in: ['CONFIRMED', 'CHECKED_IN']
            },
            OR: [
                {
                    AND: [
                        { checkIn: { gte: startDate } },
                        { checkIn: { lte: endDate } }
                    ]
                },
                {
                    AND: [
                        { checkOut: { gte: startDate } },
                        { checkOut: { lte: endDate } }
                    ]
                },
                {
                    AND: [
                        { checkIn: { lte: startDate } },
                        { checkOut: { gte: endDate } }
                    ]
                }
            ]
        };

        if (villaId) {
            where.villaId = villaId;
        }

        const bookings = await prisma.booking.findMany({
            where,
            select: {
                id: true,
                villaId: true,
                checkIn: true,
                checkOut: true,
                villa: {
                    select: {
                        name: true
                    }
                }
            },
            orderBy: {
                checkIn: 'asc'
            }
        });

        const formattedBookings = bookings.map(booking => ({
            id: booking.id.toString(),
            villaId: booking.villaId.toString(),
            villaName: booking.villa.name,
            checkIn: booking.checkIn.toISOString().split('T')[0],
            checkOut: booking.checkOut.toISOString().split('T')[0]
        }));

        return formattedBookings;
    }
    catch (error) {
        console.error(`Error fetching calendar bookings: ${error}`);
        throw new InternalServerError("Failed to fetch calendar bookings");
    }
};

// Service to Send Voucher to Both Admins
export async function sendVoucherToAdminsService(bookingId: number) {
    try {
        const admins = await getAdminContactsService();

        if (!admins.admin1.email || !admins.admin1.phone || !admins.admin2.email || !admins.admin2.phone) {
            throw new InternalServerError("Admin contact details not configured");
        };

        const voucherResult = await generateVoucherService({ bookingId: bookingId.toString() });

        if (!voucherResult || !voucherResult.voucherUrl) {
            throw new InternalServerError("Failed to generate voucher");
        };

        const voucherUrl = voucherResult.voucherUrl;
        const message = "Please review this booking voucher for approval.";

        const results = await Promise.allSettled([
            sendVoucherEmailService(bookingId.toString(), {
                email: admins.admin1.email,
                message: message,
                voucherUrl: voucherUrl
            }),
            sendVoucherEmailService(bookingId.toString(), {
                email: admins.admin2.email,
                message: message,
                voucherUrl: voucherUrl
            }),
            sendVoucherWhatsAppService(bookingId.toString(), {
                phoneNumber: admins.admin1.phone,
                message: message,
                voucherUrl: voucherUrl
            }),
            sendVoucherWhatsAppService(bookingId.toString(), {
                phoneNumber: admins.admin2.phone,
                message: message,
                voucherUrl: voucherUrl
            })
        ]);

        const emailResults = results.slice(0, 2);
        const whatsappResults = results.slice(2, 4);

        const emailSuccessCount = emailResults.filter(r => r.status === "fulfilled").length;
        const whatsappSuccessCount = whatsappResults.filter(r => r.status === "fulfilled").length;

        const emailFailures = emailResults.filter(r => r.status === "rejected");
        const whatsappFailures = whatsappResults.filter(r => r.status === "rejected");

        if (emailSuccessCount === 0 && whatsappSuccessCount === 0) {
            throw new InternalServerError("Failed to send voucher to any admin");
        }

        await prisma.booking.update({
            where: { id: bookingId },
            data: { voucherSentToAdminsAt: new Date() }
        });

        const successMessages: string[] = [];
        const failureMessages: string[] = [];

        if (emailSuccessCount > 0) {
            successMessages.push(`Email sent to ${emailSuccessCount} admin(s)`);
        }
        if (whatsappSuccessCount > 0) {
            successMessages.push(`WhatsApp sent to ${whatsappSuccessCount} admin(s)`);
        }
        if (emailFailures.length > 0) {
            failureMessages.push(`Email failed for ${emailFailures.length} admin(s)`);
        }
        if (whatsappFailures.length > 0) {
            failureMessages.push(`WhatsApp failed for ${whatsappFailures.length} admin(s)`);
        }

        return {
            success: true,
            message: successMessages.join(", "),
            warnings: failureMessages.length > 0 ? failureMessages.join(", ") : null,
            emailsSent: emailSuccessCount,
            whatsappSent: whatsappSuccessCount
        };
    }
    catch (error: any) {
        console.error(`Error sending voucher to admins: ${error}`);
        throw new InternalServerError(error.message || "Failed to send voucher to admins");
    };
};

// Service to Update Voucher Approval Status
export async function updateVoucherApprovalService(bookingId: number, approvedBy: Voucher_Approver) {
    try {
        const booking = await prisma.booking.update({
            where: { id: bookingId },
            data: {
                voucherApprovalStatus: "APPROVED",
                voucherApprovedBy: approvedBy,
                voucherApprovedAt: new Date()
            }
        });

        return booking;
    }
    catch (error) {
        console.error(`Error updating voucher approval status: ${error}`);
        throw new InternalServerError("Failed to update voucher approval status");
    };
};